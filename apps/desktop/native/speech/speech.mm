// macOS's own speech recognizer for dictation in the desktop app (#726). It runs inside the app's process, so the
// microphone and speech-recognition prompts name the app, and it recognizes on this Mac only
// (requiresOnDeviceRecognition): a language without an on-device model fails, it never falls back to a server.
// Audio buffers never leave this file and nothing is written or logged. One session at a time; every event carries
// its session id and is delivered to JavaScript through a thread-safe function.
//
// Endpointing: speechstart at the first partial result; 1.5 s without a new partial ends the audio (speechend); no
// partial within 8 s is no-speech; a session ends its audio after 60 s at most; after the audio ends the final result
// is awaited for 5 s at most. Every exit path stops the engine, removes the tap and emits `end` exactly once.

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#import <UserNotifications/UserNotifications.h>
#import <os/log.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

static const double kSilenceSeconds = 1.5;
static const double kNoSpeechSeconds = 8.0;
static const double kMaxSeconds = 60.0;
static const double kFinalGraceSeconds = 5.0;
/** Input changes before any speech that capture follows onto the new input; one more ends the session (#869). */
static const NSUInteger kMaxRestarts = 3;

typedef struct {
  int64_t session;
  char kind[16];
  char code[32];
  char *text;
  bool final;
} DictationEvent;

static void CallJs(napi_env env, napi_value callback, void *context, void *data) {
  DictationEvent *event = (DictationEvent *)data;
  if (env != NULL && callback != NULL) {
    napi_value object, value, undefined;
    napi_create_object(env, &object);
    napi_create_int64(env, event->session, &value);
    napi_set_named_property(env, object, "session", value);
    napi_create_string_utf8(env, event->kind, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, object, "kind", value);
    if (strcmp(event->kind, "result") == 0) {
      napi_create_string_utf8(env, event->text != NULL ? event->text : "", NAPI_AUTO_LENGTH, &value);
      napi_set_named_property(env, object, "text", value);
      napi_get_boolean(env, event->final, &value);
      napi_set_named_property(env, object, "final", value);
    } else if (strcmp(event->kind, "error") == 0) {
      napi_create_string_utf8(env, event->code, NAPI_AUTO_LENGTH, &value);
      napi_set_named_property(env, object, "code", value);
    }
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, callback, 1, &object, NULL);
  }
  free(event->text);
  free(event);
}

@interface DFSession : NSObject
@property(nonatomic) int64_t identifier;
@property(nonatomic) napi_threadsafe_function events;
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic) BOOL tapped;
@property(nonatomic) BOOL heard;
@property(nonatomic) BOOL audioEnded;
@property(nonatomic) BOOL ended;
@property(nonatomic) NSUInteger silenceMark;
@property(nonatomic) NSUInteger restarts;
@property(nonatomic, strong) id configObserver;
@end

@implementation DFSession
@end

static DFSession *gCurrent = nil;
static int64_t gNextSession = 1;
static NSMutableDictionary<NSString *, SFSpeechRecognizer *> *gRecognizers = nil;

static void Emit(DFSession *session, const char *kind, const char *code, NSString *text, bool final) {
  DictationEvent *event = (DictationEvent *)calloc(1, sizeof(DictationEvent));
  if (event == NULL) return;
  event->session = session.identifier;
  strlcpy(event->kind, kind, sizeof(event->kind));
  if (code != NULL) strlcpy(event->code, code, sizeof(event->code));
  if (text != nil) event->text = strdup(text.UTF8String);
  event->final = final;
  if (napi_call_threadsafe_function(session.events, event, napi_tsfn_nonblocking) != napi_ok) {
    free(event->text);
    free(event);
  }
}

static void StopAudio(DFSession *session) {
  // Each call is guarded on its own: a tap that cannot be removed (the device went away under the engine) must not
  // leave the engine, and the system's microphone indicator, running until the session object is freed.
  @try {
    if (session.tapped) [session.engine.inputNode removeTapOnBus:0];
  } @catch (NSException *exception) {
    // Teardown goes on either way; the system log keeps the cause so a broken teardown can be seen in the field (#1156).
    os_log_error(OS_LOG_DEFAULT, "speech: removing the input tap failed: %{public}@: %{public}@", exception.name,
                 exception.reason);
  }
  @try {
    if (session.engine.isRunning) [session.engine stop];
  } @catch (NSException *exception) {
    os_log_error(OS_LOG_DEFAULT, "speech: stopping the audio engine failed: %{public}@: %{public}@", exception.name,
                 exception.reason);
  }
  session.tapped = NO;
}

/** The one way a session ends: audio off, task done, an optional error, then `end`, once. */
static void Finish(DFSession *session, const char *error) {
  if (session.ended) return;
  session.ended = YES;
  if (session.configObserver != nil) {
    [[NSNotificationCenter defaultCenter] removeObserver:session.configObserver];
    session.configObserver = nil;
  }
  StopAudio(session);
  [session.request endAudio];
  [session.task cancel];
  session.task = nil;
  if (error != NULL) Emit(session, "error", error, nil, false);
  Emit(session, "end", NULL, nil, false);
  napi_release_threadsafe_function(session.events, napi_tsfn_release);
  if (gCurrent == session) gCurrent = nil;
}

static void EndAudio(DFSession *session) {
  if (session.ended || session.audioEnded) return;
  session.audioEnded = YES;
  StopAudio(session);
  [session.request endAudio];
  Emit(session, "speechend", NULL, nil, false);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kFinalGraceSeconds * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   Finish(session, NULL);
                 });
}

/**
 * Taps the engine's input at its current format into the session's request and starts the engine. AVFoundation raises
 * NSException (a device or format change between the read and the tap); it must never cross the Node-API boundary,
 * where it would abort the app, so any failure answers NO.
 */
static BOOL StartCapture(DFSession *session) {
  SFSpeechAudioBufferRecognitionRequest *request = session.request;
  @try {
    AVAudioInputNode *input = session.engine.inputNode;
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (format.sampleRate <= 0 || format.channelCount == 0) return NO;
    [input installTapOnBus:0
                bufferSize:1024
                    format:format
                     block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                       [request appendAudioPCMBuffer:buffer];
                     }];
    session.tapped = YES;
    [session.engine prepare];
    NSError *failure = nil;
    return [session.engine startAndReturnError:&failure];
  } @catch (NSException *exception) {
    return NO;
  }
}

static void ArmSilence(DFSession *session) {
  NSUInteger mark = session.silenceMark + 1;
  session.silenceMark = mark;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kSilenceSeconds * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   if (session.silenceMark == mark) EndAudio(session);
                 });
}

static SFSpeechRecognizer *RecognizerFor(NSString *lang) {
  if (gRecognizers == nil) gRecognizers = [NSMutableDictionary dictionary];
  SFSpeechRecognizer *recognizer = gRecognizers[lang];
  if (recognizer == nil) {
    recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:lang]];
    if (recognizer == nil) return nil;
    recognizer.queue = [NSOperationQueue mainQueue];
    gRecognizers[lang] = recognizer;
  }
  return recognizer;
}

static const char *ErrorCode(NSError *error) {
  if ([error.domain isEqualToString:@"kAFAssistantErrorDomain"] && error.code == 1110) return "no-speech";
  return "service";
}

static NSString *StatusName(SFSpeechRecognizerAuthorizationStatus status) {
  switch (status) {
    case SFSpeechRecognizerAuthorizationStatusAuthorized:
      return @"granted";
    case SFSpeechRecognizerAuthorizationStatusDenied:
      return @"denied";
    case SFSpeechRecognizerAuthorizationStatusRestricted:
      return @"restricted";
    default:
      return @"not-determined";
  }
}

static bool StringArg(napi_env env, napi_value value, NSString **out) {
  char buffer[64];
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, buffer, sizeof(buffer), &length) != napi_ok) return false;
  if (length == 0 || length >= sizeof(buffer) - 1) return false;
  *out = [NSString stringWithUTF8String:buffer];
  return *out != nil;
}

static napi_value Ready(napi_env env, napi_callback_info info) {
  NSDictionary *plist = [NSBundle mainBundle].infoDictionary;
  bool ready = plist[@"NSMicrophoneUsageDescription"] != nil && plist[@"NSSpeechRecognitionUsageDescription"] != nil;
  napi_value result;
  napi_get_boolean(env, ready, &result);
  return result;
}

static napi_value SpeechStatus(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_string_utf8(env, StatusName([SFSpeechRecognizer authorizationStatus]).UTF8String, NAPI_AUTO_LENGTH,
                          &result);
  return result;
}

static void ResolveStatus(napi_env env, napi_value callback, void *context, void *data) {
  char *status = (char *)data;
  if (env != NULL) {
    napi_value value;
    napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value);
    napi_resolve_deferred(env, (napi_deferred)context, value);
  }
  free(status);
}

static napi_value RequestSpeech(napi_env env, napi_callback_info info) {
  napi_deferred deferred;
  napi_value promise, name;
  napi_create_promise(env, &deferred, &promise);
  napi_create_string_utf8(env, "doriface-speech-auth", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function resolve;
  if (napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, deferred, ResolveStatus, &resolve) !=
      napi_ok) {
    napi_value error;
    napi_create_string_utf8(env, "not-determined", NAPI_AUTO_LENGTH, &error);
    napi_resolve_deferred(env, deferred, error);
    return promise;
  }
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
    napi_call_threadsafe_function(resolve, strdup(StatusName(status).UTF8String), napi_tsfn_blocking);
    napi_release_threadsafe_function(resolve, napi_tsfn_release);
  }];
  return promise;
}

static const char *NoticeStatusName(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusAuthorized:
    case UNAuthorizationStatusProvisional:
      return "granted";
    case UNAuthorizationStatusDenied:
      return "denied";
    case UNAuthorizationStatusNotDetermined:
      return "not-determined";
    default:
      // Ephemeral is value 4, but its named constant is unavailable on macOS (App Clips only).
      return (NSInteger)status == 4 ? "granted" : "unknown";
  }
}

static void ResolveNoticeStatus(napi_env env, napi_value callback, void *context, void *data) {
  if (env == NULL) return;  // The JS environment may have shut down before the OS answered.
  napi_value value;
  napi_create_string_utf8(env, (const char *)data, NAPI_AUTO_LENGTH, &value);
  napi_resolve_deferred(env, (napi_deferred)context, value);
}

static napi_value NoticeAuthorization(napi_env env, napi_callback_info info) {
  napi_deferred deferred;
  napi_value promise, name, unknown;
  napi_create_promise(env, &deferred, &promise);
  napi_create_string_utf8(env, "unknown", NAPI_AUTO_LENGTH, &unknown);
  // A bare CLI has no app identity; currentNotificationCenter would raise an exception there.
  if ([NSBundle mainBundle].bundleIdentifier == nil) {
    napi_resolve_deferred(env, deferred, unknown);
    return promise;
  }
  napi_create_string_utf8(env, "doriface-notice-auth", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function resolve;
  if (napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, deferred, ResolveNoticeStatus,
                                      &resolve) != napi_ok) {
    napi_resolve_deferred(env, deferred, unknown);
    return promise;
  }
  @try {
    [[UNUserNotificationCenter currentNotificationCenter]
        getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
          // Apple's completion may run off-thread. Only the thread-safe callback touches JS, never a blocking wait
          // on Electron's main thread. Status names are string literals, so they survive until JS receives them.
          napi_call_threadsafe_function(resolve, (void *)NoticeStatusName(settings.authorizationStatus),
                                        napi_tsfn_nonblocking);
          napi_release_threadsafe_function(resolve, napi_tsfn_release);
        }];
  } @catch (NSException *exception) {
    os_log_error(OS_LOG_DEFAULT, "notification authorization read failed: %{public}@", exception.name);
    napi_call_threadsafe_function(resolve, (void *)"unknown", napi_tsfn_nonblocking);
    napi_release_threadsafe_function(resolve, napi_tsfn_release);
  }
  return promise;
}

// Asks for permission to show notifications with the options Electron's own presenter asks for, so the two requests are
// one prompt (#1958). It settles when the person answers it, at once when the OS has an answer already: until then the
// app knows its request is on screen, since macOS can read denied meanwhile.
static napi_value RequestNoticeAuthorization(napi_env env, napi_callback_info info) {
  napi_deferred deferred;
  napi_value promise, name, unknown;
  napi_create_promise(env, &deferred, &promise);
  napi_create_string_utf8(env, "unknown", NAPI_AUTO_LENGTH, &unknown);
  // A bare CLI has no app identity; currentNotificationCenter would raise an exception there.
  if ([NSBundle mainBundle].bundleIdentifier == nil) {
    napi_resolve_deferred(env, deferred, unknown);
    return promise;
  }
  napi_create_string_utf8(env, "doriface-notice-request", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function resolve;
  if (napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, deferred, ResolveNoticeStatus,
                                      &resolve) != napi_ok) {
    napi_resolve_deferred(env, deferred, unknown);
    return promise;
  }
  @try {
    [[UNUserNotificationCenter currentNotificationCenter]
        requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound |
                                         UNAuthorizationOptionBadge)
                      completionHandler:^(BOOL granted, NSError *error) {
                        const char *answer = error != nil ? "unknown" : granted ? "granted" : "denied";
                        napi_call_threadsafe_function(resolve, (void *)answer, napi_tsfn_nonblocking);
                        napi_release_threadsafe_function(resolve, napi_tsfn_release);
                      }];
  } @catch (NSException *exception) {
    os_log_error(OS_LOG_DEFAULT, "notification permission request failed: %{public}@", exception.name);
    napi_call_threadsafe_function(resolve, (void *)"unknown", napi_tsfn_nonblocking);
    napi_release_threadsafe_function(resolve, napi_tsfn_release);
  }
  return promise;
}

static napi_value SupportsOnDevice(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSString *lang = nil;
  bool supported = false;
  if (argc == 1 && StringArg(env, argv[0], &lang)) {
    SFSpeechRecognizer *recognizer = RecognizerFor(lang);
    supported = recognizer != nil && recognizer.supportsOnDeviceRecognition;
  }
  napi_value result;
  napi_get_boolean(env, supported, &result);
  return result;
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  NSString *lang = nil;
  napi_valuetype type = napi_undefined;
  if (argc == 2) napi_typeof(env, argv[1], &type);
  if (argc != 2 || !StringArg(env, argv[0], &lang) || type != napi_function) {
    napi_throw_type_error(env, NULL, "start(lang, onEvent)");
    return NULL;
  }
  SFSpeechRecognizer *recognizer = RecognizerFor(lang);
  if (recognizer == nil || !recognizer.supportsOnDeviceRecognition) {
    napi_throw_error(env, NULL, "no on-device recognizer for this language");
    return NULL;
  }
  if (gCurrent != nil) Finish(gCurrent, "aborted");

  DFSession *session = [DFSession new];
  session.identifier = gNextSession++;
  napi_value name;
  napi_create_string_utf8(env, "doriface-dictation", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function events;
  if (napi_create_threadsafe_function(env, argv[1], NULL, name, 0, 1, NULL, NULL, NULL, CallJs, &events) != napi_ok) {
    napi_throw_error(env, NULL, "could not create the event channel");
    return NULL;
  }
  napi_unref_threadsafe_function(env, events);
  session.events = events;
  gCurrent = session;

  SFSpeechAudioBufferRecognitionRequest *request = [SFSpeechAudioBufferRecognitionRequest new];
  request.requiresOnDeviceRecognition = YES;
  request.shouldReportPartialResults = YES;
  if (@available(macOS 13.0, *)) request.addsPunctuation = YES;
  session.request = request;
  session.engine = [AVAudioEngine new];

  napi_value result;
  napi_create_int64(env, session.identifier, &result);
  if (!StartCapture(session)) {
    dispatch_async(dispatch_get_main_queue(), ^{
      Finish(session, "audio-capture");
    });
    return result;
  }
  // The input device changed (AirPods connected, a mic unplugged): the engine stops on its own. End the audio so the
  // words heard so far still arrive. When nothing was heard yet (a Bluetooth headset switching profile just after the
  // start), listen on through the new input instead, as the same session with its timers; the microphone went away
  // only when the new input cannot be started, or keeps changing (#869).
  session.configObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:AVAudioEngineConfigurationChangeNotification
                  object:session.engine
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                if (session.ended || session.audioEnded) return;
                if (session.heard) return EndAudio(session);
                session.restarts += 1;
                StopAudio(session);
                if (session.restarts > kMaxRestarts || !StartCapture(session)) Finish(session, "audio-capture");
              }];

  session.task = [recognizer
      recognitionTaskWithRequest:request
                   resultHandler:^(SFSpeechRecognitionResult *recognized, NSError *error) {
                     if (session.ended) return;
                     if (recognized != nil) {
                       if (!session.heard) {
                         session.heard = YES;
                         Emit(session, "speechstart", NULL, nil, false);
                       }
                       Emit(session, "result", NULL, recognized.bestTranscription.formattedString,
                            recognized.isFinal);
                       if (recognized.isFinal) return Finish(session, NULL);
                       if (!session.audioEnded) ArmSilence(session);
                     }
                     if (error != nil) Finish(session, session.heard ? NULL : ErrorCode(error));
                   }];

  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kNoSpeechSeconds * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   if (!session.heard) Finish(session, "no-speech");
                 });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kMaxSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(),
                 ^{
                   EndAudio(session);
                 });
  return result;
}

static DFSession *SessionArg(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int64_t identifier = 0;
  if (argc != 1 || napi_get_value_int64(env, argv[0], &identifier) != napi_ok) return nil;
  return gCurrent != nil && gCurrent.identifier == identifier ? gCurrent : nil;
}

static napi_value Stop(napi_env env, napi_callback_info info) {
  DFSession *session = SessionArg(env, info);
  if (session != nil) EndAudio(session);
  return NULL;
}

static napi_value Abort(napi_env env, napi_callback_info info) {
  DFSession *session = SessionArg(env, info);
  if (session != nil) Finish(session, "aborted");
  return NULL;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"ready", NULL, Ready, NULL, NULL, NULL, napi_default, NULL},
      {"speechStatus", NULL, SpeechStatus, NULL, NULL, NULL, napi_default, NULL},
      {"requestSpeech", NULL, RequestSpeech, NULL, NULL, NULL, napi_default, NULL},
      {"noticeAuthorization", NULL, NoticeAuthorization, NULL, NULL, NULL, napi_default, NULL},
      {"requestNoticeAuthorization", NULL, RequestNoticeAuthorization, NULL, NULL, NULL, napi_default, NULL},
      {"supportsOnDevice", NULL, SupportsOnDevice, NULL, NULL, NULL, napi_default, NULL},
      {"start", NULL, Start, NULL, NULL, NULL, napi_default, NULL},
      {"stop", NULL, Stop, NULL, NULL, NULL, napi_default, NULL},
      {"abort", NULL, Abort, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
