#include <windows.h>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>
#include "../src/script_cache.h"

#define CHECK(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)
static void writeFile(const std::wstring& path, const std::string& content) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
    CHECK(h != INVALID_HANDLE_VALUE);
    DWORD count = 0;
    BOOL ok = WriteFile(h, content.data(), static_cast<DWORD>(content.size()), &count, nullptr);
    CloseHandle(h); CHECK(ok && count == content.size());
}
int main() {
    wchar_t dir[MAX_PATH], name[MAX_PATH];
    if (!GetTempPathW(MAX_PATH, dir) || !GetTempFileNameW(dir, L"cfc", 0, name)) return 1;
    struct Cleanup { const wchar_t* file; ~Cleanup() { DeleteFileW(file); } } cleanup{ name };
    try {
        int prepared = 0;
        ScriptFileCache cache([&](const std::wstring& text) { ++prepared; return L"encoded:" + text; });
        writeFile(name, "first");
        auto first = cache.load(name);
        CHECK(first && *first == L"encoded:first" && prepared == 1);
        CHECK(cache.load(name) == first && prepared == 1);
        std::vector<std::shared_ptr<const std::wstring>> values(8);
        std::vector<std::thread> threads;
        for (size_t i = 0; i < values.size(); ++i) threads.emplace_back([&, i]() { values[i] = cache.load(name); });
        for (auto& t : threads) t.join();
        for (auto& value : values) CHECK(value == first);
        CHECK(prepared == 1);
        WIN32_FILE_ATTRIBUTE_DATA attributes{};
        CHECK(GetFileAttributesExW(name, GetFileExInfoStandard, &attributes));
        // Windows can coalesce change-time updates made within one clock tick.
        // Cross that boundary before restoring LastWriteTime so this test checks
        // ChangeTime invalidation instead of depending on scheduler timing.
        Sleep(32);
        writeFile(name, "other");
        HANDLE h = CreateFileW(name, FILE_WRITE_ATTRIBUTES, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
        CHECK(h != INVALID_HANDLE_VALUE);
        BOOL restored = SetFileTime(h, nullptr, nullptr, &attributes.ftLastWriteTime);
        CloseHandle(h); CHECK(restored);
        auto second = cache.load(name);
        CHECK(second && *second == L"encoded:other" && prepared == 2);
        CHECK(*first == L"encoded:first"); // Existing readers retain their snapshot.
        CHECK(DeleteFileW(name));
        CHECK(!cache.load(name));
        writeFile(name, "other");
        CHECK(cache.load(name) && prepared == 3);
        writeFile(name, "\xFF");
        CHECK(!cache.load(name)); // Invalid UTF-8 must not fall back to old data.
        writeFile(name, ""); CHECK(!cache.load(name));
        writeFile(name, "\xEF\xBB\xBF" "utf8");
        CHECK(*cache.load(name) == L"encoded:utf8");
        h = CreateFileW(name, GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        CHECK(h != INVALID_HANDLE_VALUE);
        auto locked = cache.load(name); CloseHandle(h);
        CHECK(!locked);
        CHECK(cache.load(name));
        std::cout << "PASS: cache reuse, concurrent readers, invalidation, timestamp preservation, missing/locked/invalid files\n";
        return 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
