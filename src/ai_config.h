#pragma once
#include <windows.h>
#include <string>
#include "embedded_script.h"

// JSON is data, never executable source. Escape every UTF-16 unit, including
// quotes, line separators and script terminators, before passing it to JSON.parse.
inline std::wstring AiConfigPrelude(const std::string& bytes) {
    if (bytes.size() > 65536) return L"window.__CX_AI_CONFIG__={};";
    std::wstring text;
    if (!ScriptUtf8ToWide(bytes, text)) return L"window.__CX_AI_CONFIG__={};";
    if (!text.empty() && text.front() == 0xfeff) text.erase(0, 1);
    const wchar_t hex[] = L"0123456789abcdef";
    std::wstring escaped;
    for (wchar_t ch : text) {
        escaped += L"\\u";
        for (int shift = 12; shift >= 0; shift -= 4) escaped += hex[(ch >> shift) & 15];
    }
    return L"if(window.__cefInjectionAllowed&&!window.__cefDeepSeek){try{window.__CX_AI_CONFIG__=JSON.parse(\"" +
        escaped + L"\");}catch(e){window.__CX_AI_CONFIG__={};}}";
}

inline std::wstring ReadAiConfigFile(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return AiConfigPrelude("{}");
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 || size.QuadPart > 65536) {
        CloseHandle(file); return AiConfigPrelude("{}");
    }
    std::string bytes(static_cast<size_t>(size.QuadPart), '\0');
    DWORD read = 0;
    const bool ok = ReadFile(file, bytes.empty() ? nullptr : &bytes[0], static_cast<DWORD>(bytes.size()), &read, nullptr) != FALSE;
    CloseHandle(file);
    return AiConfigPrelude(ok && read == bytes.size() ? bytes : "{}");
}

inline std::wstring AiConfigPath() {
    HMODULE module = nullptr;
    wchar_t path[32768]{};
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&AiConfigPath), &module)) return {};
    DWORD n = GetModuleFileNameW(module, path, _countof(path));
    if (!n || n >= _countof(path)) return {};
    std::wstring name(path, n);
    auto separator = name.find_last_of(L"\\/");
    return separator == std::wstring::npos ? std::wstring() :
        name.substr(0, separator + 1) + L"config.json";
}

inline bool WriteAiConfigFile(const std::wstring& path, const std::string& bytes) {
    if (path.empty() || bytes.empty() || bytes.size() > 65536 ||
        bytes.find('\0') != std::string::npos) return false;
    const auto first = bytes.find_first_not_of(" \t\r\n");
    const auto last = bytes.find_last_not_of(" \t\r\n");
    if (first == std::string::npos || bytes[first] != '{' || bytes[last] != '}') return false;
    const std::wstring temporary = path + L".tmp";
    HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const bool ok = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) != FALSE &&
        written == bytes.size() && FlushFileBuffers(file) != FALSE;
    CloseHandle(file);
    if (!ok || !MoveFileExW(temporary.c_str(), path.c_str(),
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(temporary.c_str());
        return false;
    }
    return true;
}

inline bool SaveAiConfigFile(const std::string& bytes) {
    return WriteAiConfigFile(AiConfigPath(), bytes);
}

inline std::wstring LoadAiConfigPrelude() {
    const auto path = AiConfigPath();
    return path.empty() ? AiConfigPrelude("{}") : ReadAiConfigFile(path);
}
