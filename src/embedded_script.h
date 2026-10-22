#pragma once
#include <windows.h>
#include <compressapi.h>
#include <bcrypt.h>
#include <string>
#include <cstring>

inline bool ScriptUtf8ToWide(const std::string& bytes, std::wstring& output) {
    output.clear();
    if (bytes.empty() || bytes.size() > 16 * 1024 * 1024) return false;
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(),
        static_cast<int>(bytes.size()), nullptr, 0);
    if (length <= 0) return false;
    output.resize(length);
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(),
        static_cast<int>(bytes.size()), &output[0], length)) { output.clear(); return false; }
    return true;
}

// CXZ1: magic[4], LE size/algorithm[4], SHA256[32], compression buffer.
// Low 28 bits = decoded size; high 4 = algorithm (4 XPRESS_HUFF, 5 LZMS).
// Hash detects accidental corruption, not a substitute for signing the DLL.
inline bool DecodeScriptPacket(const unsigned char* packet, size_t size, std::string& output) {
    output.clear();
    constexpr size_t limit = 16 * 1024 * 1024;
    if (!packet || size <= 40 || size > limit || std::memcmp(packet, "CXZ1", 4)) return false;
    unsigned long expected = 0; std::memcpy(&expected, packet + 4, 4);
    DWORD algorithmId = expected >> 28; expected &= 0x0fffffff;
    if (!algorithmId) algorithmId = COMPRESS_ALGORITHM_XPRESS_HUFF;
    if (algorithmId != COMPRESS_ALGORITHM_XPRESS_HUFF && algorithmId != COMPRESS_ALGORITHM_LZMS) return false;
    if (!expected || expected > limit) return false;
    DECOMPRESSOR_HANDLE decoder = nullptr;
    if (!CreateDecompressor(algorithmId, nullptr, &decoder)) return false;
    output.resize(expected);
    SIZE_T actual = 0;
    const BOOL ok = Decompress(decoder, packet + 40, size - 40, &output[0], expected, &actual);
    CloseDecompressor(decoder);
    if (!ok || actual != expected) { output.clear(); return false; }
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    unsigned char digest[32]{};
    bool valid = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0;
    BCRYPT_HASH_HANDLE hash = nullptr;
    if (valid) valid = BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) >= 0;
    if (valid) valid = BCryptHashData(hash, reinterpret_cast<PUCHAR>(&output[0]), expected, 0) >= 0;
    if (valid) valid = BCryptFinishHash(hash, digest, sizeof(digest), 0) >= 0;
    if (hash) BCryptDestroyHash(hash);
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!valid || std::memcmp(digest, packet + 8, sizeof(digest))) { output.clear(); return false; }
    return true;
}
