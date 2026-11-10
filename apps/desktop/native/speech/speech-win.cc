// SAPI 5 dictation, inside this process only (#749). No shared recognizer, WinRT recognizer, or network service.
// The main process reads Windows microphone privacy before start(). All COM objects live on one worker apartment;
// only copied text crosses its Node-API thread-safe function. No microphone audio is saved or logged.
//
// Endpointing matches speech.mm: speechstart at the first partial result; 1.5 s without new words ends the audio
// (speechend); no words within 8 s is no-speech; a session ends its audio after 60 s at most; after the audio ends the
// final result is awaited for 5 s at most. Every exit path deactivates the recognizer and emits `end` exactly once.
#define NOMINMAX
#include <windows.h>
#include <sapi.h>
#include <sperror.h>
#include <wrl/client.h>
#include <node_api.h>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>

using Microsoft::WRL::ComPtr;

struct Apartment {
  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};

// Match the requested LANGID, never the default recognizer or another language.
static HRESULT TokenFor(const std::wstring& language, ISpObjectToken** token) {
  LCID locale = LocaleNameToLCID(language.c_str(), 0);
  if (!locale) return SPERR_NOT_FOUND;
  wchar_t attributes[32];
  swprintf_s(attributes, L"Language=%x", static_cast<unsigned int>(LANGIDFROMLCID(locale)));
  ComPtr<ISpObjectTokenCategory> category;
  HRESULT hr = CoCreateInstance(CLSID_SpObjectTokenCategory, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&category));
  if (FAILED(hr)) return hr;
  hr = category->SetId(SPCAT_RECOGNIZERS, FALSE);
  if (FAILED(hr)) return hr;
  ComPtr<IEnumSpObjectTokens> tokens;
  hr = category->EnumTokens(attributes, nullptr, &tokens);
  if (FAILED(hr)) return hr;
  return tokens->Next(1, token, nullptr) == S_OK ? S_OK : SPERR_NOT_FOUND;
}

struct Event {
  int64_t session;
  const char* kind;
  const char* code;
  std::wstring text;
  bool final;
};

static void CallJs(napi_env env, napi_value callback, void*, void* data) {
  std::unique_ptr<Event> event(static_cast<Event*>(data));
  if (!env || !callback) return;
  napi_value object, value, undefined;
  napi_create_object(env, &object);
  napi_create_int64(env, event->session, &value);
  napi_set_named_property(env, object, "session", value);
  napi_create_string_utf8(env, event->kind, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "kind", value);
  if (event->code) {
    napi_create_string_utf8(env, event->code, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, object, "code", value);
  }
  if (std::string(event->kind) == "result") {
    napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(event->text.data()), event->text.size(), &value);
    napi_set_named_property(env, object, "text", value);
    napi_get_boolean(env, event->final, &value);
    napi_set_named_property(env, object, "final", value);
  }
  napi_get_undefined(env, &undefined);
  napi_call_function(env, undefined, callback, 1, &object, nullptr);
}

struct Session {
  int64_t id;
  napi_threadsafe_function events;
  std::atomic<int> command{0}; // 0 listen, 1 drain buffered audio, 2 abort immediately
  std::thread worker;
  void Emit(const char* kind, const char* code = nullptr, const std::wstring& text = L"", bool final = false) {
    auto event = new Event{id, kind, code, text, final};
    if (napi_call_threadsafe_function(events, event, napi_tsfn_nonblocking) != napi_ok) delete event;
  }
  ~Session() {
    command.store(2);
    if (worker.joinable()) worker.join();
  }
};

struct State {
  int64_t next = 1;
  std::unique_ptr<Session> current;
};

// A failed audio operation gets its own reason; a Windows privacy change during capture still names Settings.
static const char* AudioError(HRESULT hr) {
  return hr == E_ACCESSDENIED || hr == HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED) ? "mic-windows" : "audio-capture";
}

static const char* Recognize(Session* session, const std::wstring& language, const std::wstring& file) {
  Apartment apartment;
  if (FAILED(apartment.result)) return "service";
  ComPtr<ISpObjectToken> token;
  if (FAILED(TokenFor(language, &token))) return "device-windows";
  ComPtr<ISpRecognizer> recognizer;
  HRESULT hr = CoCreateInstance(CLSID_SpInprocRecognizer, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&recognizer));
  if (FAILED(hr)) return "service";
  if (FAILED(recognizer->SetRecognizer(token.Get()))) return "device-windows";
  if (FAILED(recognizer->SetRecoState(SPRST_INACTIVE))) return "service";

  ComPtr<ISpStream> stream;
  ComPtr<ISpObjectToken> microphone;
  if (!file.empty()) {
    hr = CoCreateInstance(CLSID_SpStream, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&stream));
    if (SUCCEEDED(hr)) hr = stream->BindToFile(file.c_str(), SPFM_OPEN_READONLY, nullptr, nullptr, 0);
    if (SUCCEEDED(hr)) hr = recognizer->SetInput(stream.Get(), FALSE);
  } else {
    // Resolve the default audio token afresh each start (including after unplugging/changing microphones).
    ComPtr<ISpObjectTokenCategory> category;
    hr = CoCreateInstance(CLSID_SpObjectTokenCategory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&category));
    if (SUCCEEDED(hr)) hr = category->SetId(SPCAT_AUDIOIN, FALSE);
    wchar_t* id = nullptr;
    if (SUCCEEDED(hr)) hr = category->GetDefaultTokenId(&id);
    if (SUCCEEDED(hr)) hr = CoCreateInstance(CLSID_SpObjectToken, nullptr, CLSCTX_INPROC_SERVER,
                                            IID_PPV_ARGS(&microphone));
    if (SUCCEEDED(hr)) hr = microphone->SetId(nullptr, id, FALSE);
    CoTaskMemFree(id);
    if (SUCCEEDED(hr)) hr = recognizer->SetInput(microphone.Get(), TRUE);
  }
  if (FAILED(hr)) return AudioError(hr);

  ComPtr<ISpRecoContext> context;
  if (FAILED(recognizer->CreateRecoContext(&context))) return "service";
  if (FAILED(context->SetNotifyWin32Event())) return "service";
  const ULONGLONG interest = SPFEI(SPEI_HYPOTHESIS) | SPFEI(SPEI_RECOGNITION) |
                             SPFEI(SPEI_END_SR_STREAM) | SPFEI(SPEI_FALSE_RECOGNITION);
  if (FAILED(context->SetInterest(interest, interest))) return "service";
  ComPtr<ISpRecoGrammar> grammar;
  if (FAILED(context->CreateGrammar(1, &grammar))) return "service";
  if (FAILED(grammar->LoadDictation(nullptr, SPLO_STATIC))) return "device-windows";
  if (FAILED(grammar->SetDictationState(SPRS_ACTIVE))) return "device-windows";
  // All return paths after activation purge and close the input before COM teardown.
  struct StopRecognition {
    ISpRecognizer* recognizer;
    ~StopRecognition() { recognizer->SetRecoState(SPRST_INACTIVE_WITH_PURGE); }
  } stop{recognizer.Get()};
  hr = recognizer->SetRecoState(SPRST_ACTIVE);
  if (FAILED(hr)) return AudioError(hr);
  const ULONGLONG started = GetTickCount64();
  ULONGLONG lastWords = started, draining = 0;
  bool heard = false, ended = false;
  std::wstring committed, partial;
  const char* failure = nullptr;
  while (!ended) {
    if (session->command.load() == 2) return "aborted";
    WaitForSingleObject(context->GetNotifyEventHandle(), 50);
    SPEVENT event{};
    ULONG fetched = 0;
    while (context->GetEvents(1, &event, &fetched) == S_OK && fetched == 1) {
      if (event.eEventId == SPEI_RECOGNITION || event.eEventId == SPEI_HYPOTHESIS) {
        auto result = reinterpret_cast<ISpRecoResult*>(event.lParam);
        wchar_t* text = nullptr;
        const ULONG whole = static_cast<ULONG>(SP_GETWHOLEPHRASE);
        if (result && SUCCEEDED(result->GetText(whole, whole, TRUE, &text, nullptr))) {
          partial = text ? text : L"";
          CoTaskMemFree(text);
          if (!partial.empty()) {
            if (!heard) session->Emit("speechstart");
            heard = true;
            lastWords = GetTickCount64();
            if (event.eEventId == SPEI_RECOGNITION) {
              if (!committed.empty()) committed += L" ";
              committed += partial;
              partial.clear();
            }
            std::wstring transcript = committed + (committed.empty() || partial.empty() ? L"" : L" ") + partial;
            // Same IPC bound as macOS; end rather than send an event the page must discard.
            if (transcript.size() > 10000) { failure = "service"; ended = true; }
            else session->Emit("result", nullptr, transcript, false);
          }
        }
      } else if (event.eEventId == SPEI_END_SR_STREAM) {
        ended = true;
        HRESULT streamError = static_cast<HRESULT>(event.lParam);
        if (FAILED(streamError)) failure = AudioError(streamError);
      }
      if (event.elParamType == SPET_LPARAM_IS_OBJECT || event.elParamType == SPET_LPARAM_IS_TOKEN) {
        if (event.lParam) reinterpret_cast<IUnknown*>(event.lParam)->Release();
      } else if (event.elParamType == SPET_LPARAM_IS_POINTER || event.elParamType == SPET_LPARAM_IS_STRING) {
        CoTaskMemFree(reinterpret_cast<void*>(event.lParam));
      }
    }
    const ULONGLONG now = GetTickCount64();
    if (!heard && now - started >= 8000) return "no-speech";
    if (!ended && !draining && (session->command.load() == 1 || now - started >= 60000 ||
                                (heard && now - lastWords >= 1500))) {
      session->Emit("speechend");
      hr = recognizer->SetRecoState(SPRST_INACTIVE); // closes input, finishes buffered words
      if (FAILED(hr)) return AudioError(hr);
      draining = now;
    }
    if (draining && now - draining >= 5000) ended = true;
  }
  if (session->command.load() == 2) return "aborted";
  if (failure) return failure;
  if (committed.empty()) return "no-speech";
  if (!draining) session->Emit("speechend");
  session->Emit("result", nullptr, committed, true);
  return nullptr;
}

static bool StringArg(napi_env env, napi_value value, std::wstring& result, size_t maximum) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || !length || length > maximum) return false;
  std::u16string text(length + 1, u'\0');
  if (napi_get_value_string_utf16(env, value, text.data(), text.size(), &length) != napi_ok) return false;
  result.assign(reinterpret_cast<const wchar_t*>(text.data()), length);
  return result.find(L'\0') == std::wstring::npos;
}

static napi_value Ready(napi_env env, napi_callback_info) {
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value SpeechStatus(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_string_utf8(env, "granted", NAPI_AUTO_LENGTH, &result);
  return result; // SAPI has no separate speech privacy prompt; Windows microphone privacy is checked by Electron.
}

static napi_value RequestSpeech(napi_env env, napi_callback_info info) {
  napi_value promise;
  napi_deferred deferred;
  napi_create_promise(env, &deferred, &promise);
  napi_resolve_deferred(env, deferred, SpeechStatus(env, info));
  return promise;
}

static napi_value SupportsOnDevice(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], result;
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::wstring language;
  bool supported = false;
  if (argc == 1 && StringArg(env, argv[0], language, 63)) {
    // Electron owns its main-thread apartment. Enumerate on our own apartment without changing its COM model.
    std::thread worker([&] {
      Apartment apartment;
      ComPtr<ISpObjectToken> token;
      supported = SUCCEEDED(apartment.result) && SUCCEEDED(TokenFor(language, &token));
    });
    worker.join();
  }
  napi_get_boolean(env, supported, &result);
  return result;
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3], name, result;
  void* fileInput = nullptr;
  napi_get_cb_info(env, info, &argc, argv, nullptr, &fileInput);
  const bool fromFile = fileInput != nullptr;
  std::wstring language, file;
  napi_valuetype type;
  if (argc != (fromFile ? 3u : 2u) || !StringArg(env, argv[0], language, 63) ||
      (fromFile && !StringArg(env, argv[1], file, 32767)) ||
      napi_typeof(env, argv[fromFile ? 2 : 1], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "start requires a language and callback (startFile also requires a WAV path)");
    return nullptr;
  }
  State* state = nullptr;
  napi_get_instance_data(env, reinterpret_cast<void**>(&state));
  state->current.reset(); // joins and closes the previous input before opening another
  auto session = std::make_unique<Session>();
  session->id = state->next++;
  napi_create_string_utf8(env, "doriface-sapi", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[fromFile ? 2 : 1], nullptr, name, 0, 1, nullptr, nullptr,
                                    nullptr, CallJs, &session->events) != napi_ok) {
    napi_throw_error(env, nullptr, "cannot create SAPI event channel");
    return nullptr;
  }
  Session* current = session.get();
  try {
    session->worker = std::thread([current, language, file] {
      const char* error = nullptr;
      try { error = Recognize(current, language, file); }
      catch (...) { error = "service"; }
      if (error) current->Emit("error", error);
      current->Emit("end");
      napi_release_threadsafe_function(current->events, napi_tsfn_release);
    });
  } catch (...) {
    napi_release_threadsafe_function(session->events, napi_tsfn_release);
    napi_throw_error(env, nullptr, "cannot create SAPI worker");
    return nullptr;
  }
  napi_create_int64(env, session->id, &result);
  state->current = std::move(session);
  return result;
}

static napi_value Command(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], result;
  void* command = nullptr;
  napi_get_cb_info(env, info, &argc, argv, nullptr, &command);
  int64_t id = 0;
  State* state = nullptr;
  napi_get_instance_data(env, reinterpret_cast<void**>(&state));
  if (argc == 1 && napi_get_value_int64(env, argv[0], &id) == napi_ok &&
      state->current && state->current->id == id) {
    if (command) state->current.reset(); // abort closes audio before returning (reload/close/quit)
    else if (state->current->command.load() == 0) state->current->command.store(1);
  }
  napi_get_undefined(env, &result);
  return result;
}

static void Cleanup(void* data) { delete static_cast<State*>(data); }

static napi_value Init(napi_env env, napi_value exports) {
  auto state = new State();
  napi_set_instance_data(env, state, nullptr, nullptr);
  napi_add_env_cleanup_hook(env, Cleanup, state);
  napi_property_descriptor methods[] = {
    {"ready", nullptr, Ready, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"speechStatus", nullptr, SpeechStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"requestSpeech", nullptr, RequestSpeech, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"supportsOnDevice", nullptr, SupportsOnDevice, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    // Main-process CI probe only. No IPC channel exposes files or audio to a renderer.
    {"startFile", nullptr, Start, nullptr, nullptr, nullptr, napi_default, state},
    {"stop", nullptr, Command, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"abort", nullptr, Command, nullptr, nullptr, nullptr, napi_default, state},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
