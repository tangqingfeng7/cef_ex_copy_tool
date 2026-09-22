#include <windows.h>
#include <iostream>
#include <string>
#include <vector>
#include "../src/crash_dump.h"

#define CHECK(x) do { if (!(x)) { std::cerr << #x << '\n'; return 1; } } while (0)

int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring(argv[1]) == L"--crash") {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
        if (!InstallCrashDumpHandler()) return 2;
        RaiseException(EXCEPTION_ACCESS_VIOLATION, EXCEPTION_NONCONTINUABLE, 0, nullptr);
        return 3;
    }

    wchar_t temp[MAX_PATH] = {};
    CHECK(GetTempPathW(MAX_PATH, temp));
    std::wstring directory = std::wstring(temp) + L"cef-dump-test-" + std::to_wstring(GetCurrentProcessId());
    CreateDirectoryW(directory.c_str(), nullptr);
    CHECK(SetEnvironmentVariableW(L"CEF_CX_DUMP_DIR", directory.c_str()));

    wchar_t executable[32768] = {};
    CHECK(GetModuleFileNameW(nullptr, executable, static_cast<DWORD>(_countof(executable))));
    std::wstring command = L"\"" + std::wstring(executable) + L"\" --crash";
    std::vector<wchar_t> mutableCommand(command.begin(), command.end());
    mutableCommand.push_back(L'\0');
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    CHECK(CreateProcessW(executable, mutableCommand.data(), nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process));
    CHECK(WaitForSingleObject(process.hProcess, 15000) == WAIT_OBJECT_0);
    DWORD exitCode = 0;
    CHECK(GetExitCodeProcess(process.hProcess, &exitCode));
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    SetEnvironmentVariableW(L"CEF_CX_DUMP_DIR", nullptr);
    CHECK(exitCode != 0);

    WIN32_FIND_DATAW data{};
    HANDLE found = FindFirstFileW((directory + L"\\*.dmp").c_str(), &data);
    CHECK(found != INVALID_HANDLE_VALUE);
    CHECK(data.nFileSizeHigh || data.nFileSizeLow > 0);
    std::wstring dump = directory + L"\\" + data.cFileName;
    FindClose(found);
    CHECK(DeleteFileW(dump.c_str()));
    CHECK(RemoveDirectoryW(directory.c_str()));
    std::cout << "PASS: unhandled exception produces a local versioned minidump\n";
    return 0;
}
