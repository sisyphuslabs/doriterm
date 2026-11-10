// Electron's node.lib binds the Node-API symbols speech.node imports to node.exe, but Electron exports them from its
// own executable, which electron-builder names Doriterm.exe; Windows looking for node.exe beside the app would fail
// to load the addon, and the app would report it can't dictate (#749). So the addon delay-loads node.exe
// (/DELAYLOAD:node.exe delayimp.lib, scripts/build-speech-win.ts) and this hook answers that load with the running
// executable, as node-gyp's src/win_delay_load_hook.cc does for every addon it builds.
//
// After node-gyp's win_delay_load_hook.cc, Copyright (c) 2012 Nathan Rajlich, MIT License
// (https://github.com/nodejs/node-gyp/blob/main/LICENSE).
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI load_exe_hook(unsigned int event, DelayLoadInfo* info) {
  if (event != dliNotePreLoadLibrary) return NULL;
  if (_stricmp(info->szDll, "node.exe") != 0) return NULL;
  return (FARPROC)GetModuleHandle(NULL);
}

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = load_exe_hook;
