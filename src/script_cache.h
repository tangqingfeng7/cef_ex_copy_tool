#pragma once
#include <windows.h>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

// One bounded entry per script. Readers keep an immutable snapshot across reloads.
class ScriptFileCache {
    struct Handle {
        HANDLE value;
        ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    };
    struct Stamp {
        BY_HANDLE_FILE_INFORMATION file{};
        FILE_BASIC_INFO basic{};
        bool read(HANDLE handle) {
            return GetFileInformationByHandle(handle, &file) &&
                GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic));
        }
        bool operator==(const Stamp& other) const {
            return file.dwVolumeSerialNumber == other.file.dwVolumeSerialNumber &&
                file.nFileIndexHigh == other.file.nFileIndexHigh && file.nFileIndexLow == other.file.nFileIndexLow &&
                file.nFileSizeHigh == other.file.nFileSizeHigh && file.nFileSizeLow == other.file.nFileSizeLow &&
                basic.LastWriteTime.QuadPart == other.basic.LastWriteTime.QuadPart &&
                basic.ChangeTime.QuadPart == other.basic.ChangeTime.QuadPart;
        }
    };
    std::mutex mutex_;
    std::wstring path_;
    Stamp stamp_;
    std::shared_ptr<const std::wstring> prepared_;
    std::function<std::wstring(const std::wstring&)> prepare_;
public:
    explicit ScriptFileCache(std::function<std::wstring(const std::wstring&)> prepare)
        : prepare_(std::move(prepare)) {}

    std::shared_ptr<const std::wstring> load(const std::wstring& path) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto fail = [this]() { prepared_.reset(); return prepared_; };
        // A handle pins the file identity and denies writes/replacement during use.
        Handle handle{ CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr) };
        if (handle.value == INVALID_HANDLE_VALUE) return fail();
        Stamp current;
        if (!current.read(handle.value)) return fail();
        if (prepared_ && path_ == path && stamp_ == current) return prepared_;
        if (current.file.nFileSizeHigh || !current.file.nFileSizeLow ||
            current.file.nFileSizeLow > 64 * 1024 * 1024) return fail();
        std::string bytes(current.file.nFileSizeLow, '\0');
        DWORD count = 0;
        if (!ReadFile(handle.value, &bytes[0], static_cast<DWORD>(bytes.size()), &count, nullptr) ||
            count != bytes.size()) return fail();
        Stamp after;
        if (!after.read(handle.value) || !(current == after)) return fail();
        if (bytes.compare(0, 3, "\xEF\xBB\xBF") == 0) bytes.erase(0, 3);
        if (bytes.empty()) return fail();
        const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(),
            static_cast<int>(bytes.size()), nullptr, 0);
        if (size <= 0) return fail();
        std::wstring text(size, L'\0');
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(),
            static_cast<int>(bytes.size()), &text[0], size) != size) return fail();
        auto prepared = std::make_shared<const std::wstring>(prepare_(text));
        path_ = path;
        stamp_ = current;
        prepared_ = prepared;
        return prepared;
    }
};
