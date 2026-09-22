#include "pch.h"
#include "build_info.h"
#include "crash_dump.h"
#include <DbgHelp.h>
#include <ShlObj.h>

namespace {
volatile LONG g_installState = 0; // 0 idle, 1 installing, 2 installed, 3 failed
volatile LONG g_dumpStarted = 0;
volatile LONG g_lastError = 0;
LPTOP_LEVEL_EXCEPTION_FILTER g_previousFilter = nullptr;
std::wstring g_dumpDirectory;

#define CEF_WIDEN_INNER(value) L##value
#define CEF_WIDEN(value) CEF_WIDEN_INNER(value)

const wchar_t* InstallStateName(LONG state) {
    switch (state) {
    case 1: return L"installing";
    case 2: return L"installed";
    case 3: return L"failed";
    default: return L"idle";
    }
}

std::wstring JsonEscape(const std::wstring& input) {
    std::wstring result;
    result.reserve(input.size() + 8);
    for (wchar_t ch : input) {
        if (ch == L'\\' || ch == L'"') result += L'\\';
        if (ch >= 0x20) result += ch;
    }
    return result;
}

bool PrepareDumpDirectory() {
    wchar_t configured[32768] = {};
    DWORD length = GetEnvironmentVariableW(L"CEF_CX_DUMP_DIR", configured,
        static_cast<DWORD>(_countof(configured)));
    if (length && length < _countof(configured)) {
        g_dumpDirectory.assign(configured, length);
    } else {
        wchar_t localAppData[32768] = {};
        length = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData,
            static_cast<DWORD>(_countof(localAppData)));
        if (!length || length >= _countof(localAppData)) {
            InterlockedExchange(&g_lastError, ERROR_PATH_NOT_FOUND);
            return false;
        }
        g_dumpDirectory.assign(localAppData, length);
        g_dumpDirectory += L"\\cef_ex_copy_tool\\crash-dumps";
    }
    int result = SHCreateDirectoryExW(nullptr, g_dumpDirectory.c_str(), nullptr);
    if (result != ERROR_SUCCESS && result != ERROR_ALREADY_EXISTS && result != ERROR_FILE_EXISTS) {
        InterlockedExchange(&g_lastError, result);
        return false;
    }
    return true;
}

LONG WINAPI WriteUnhandledDump(EXCEPTION_POINTERS* exceptionPointers) {
    if (InterlockedCompareExchange(&g_dumpStarted, 1, 0) == 0) {
        SYSTEMTIME time{};
        GetLocalTime(&time);
        wchar_t fileName[512] = {};
        _snwprintf_s(fileName, _TRUNCATE,
            L"cef_ex_copy_tool-v%s-pid%lu-%04u%02u%02u-%02u%02u%02u-%03u.dmp",
            CEF_WIDEN(CEF_CX_VERSION_STRING), GetCurrentProcessId(),
            time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute,
            time.wSecond, time.wMilliseconds);
        wchar_t path[32768] = {};
        _snwprintf_s(path, _TRUNCATE, L"%s\\%s", g_dumpDirectory.c_str(), fileName);
        HANDLE file = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ,
            nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file != INVALID_HANDLE_VALUE) {
            MINIDUMP_EXCEPTION_INFORMATION exceptionInfo{};
            exceptionInfo.ThreadId = GetCurrentThreadId();
            exceptionInfo.ExceptionPointers = exceptionPointers;
            exceptionInfo.ClientPointers = FALSE;
            BOOL written = MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), file,
                MiniDumpNormal, exceptionPointers ? &exceptionInfo : nullptr, nullptr, nullptr);
            if (!written) {
                InterlockedExchange(&g_lastError, static_cast<LONG>(GetLastError()));
            }
            CloseHandle(file);
            if (!written) DeleteFileW(path);
        } else {
            InterlockedExchange(&g_lastError, static_cast<LONG>(GetLastError()));
        }
    }

    LONG result = EXCEPTION_EXECUTE_HANDLER;
    if (g_previousFilter && g_previousFilter != WriteUnhandledDump)
        result = g_previousFilter(exceptionPointers);
    if (result == EXCEPTION_CONTINUE_EXECUTION)
        InterlockedExchange(&g_dumpStarted, 0);
    return result;
}
}

bool InstallCrashDumpHandler() {
    LONG previous = InterlockedCompareExchange(&g_installState, 1, 0);
    if (previous != 0) return previous == 2;
    if (!PrepareDumpDirectory()) {
        InterlockedExchange(&g_installState, 3);
        return false;
    }
    g_previousFilter = SetUnhandledExceptionFilter(WriteUnhandledDump);
    InterlockedExchange(&g_installState, 2);
    OutputDebugStringW((L"[CefHook] crash dumps: " + g_dumpDirectory + L"\n").c_str());
    return true;
}

std::wstring CrashDumpDiagnosticsJson() {
    const LONG state = InterlockedCompareExchange(&g_installState, 0, 0);
    const LONG error = InterlockedCompareExchange(&g_lastError, 0, 0);
    return L"{\"status\":\"" + std::wstring(InstallStateName(state)) +
        L"\",\"directory\":\"" + JsonEscape(g_dumpDirectory) +
        L"\",\"lastError\":" + std::to_wstring(error) + L"}";
}
