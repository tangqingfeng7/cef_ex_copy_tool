#pragma once
#include <array>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <algorithm>
#include <cctype>

namespace AiHotkeys {
enum Action { None = -1, Panel = 0, Selection = 1, Pause = 2, Capture = 3 };
enum Modifier { Control = 1, Alt = 2, Shift = 4 };
struct Binding { int key = 0, modifiers = 0; std::string combo; };
using Bindings = std::array<Binding, 4>;
inline const char* Name(int index) { static const char* names[] = {"panel", "selection", "pause", "capture"}; return names[index]; }
inline bool Parse(const std::string& input, Binding& result) {
    if (input.empty() || input.size() > 40) return false;
    std::string text = input;
    for (auto& c : text) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    std::istringstream in(text); std::string part, key; int modifiers = 0;
    while (std::getline(in, part, '+')) {
        int bit = part == "CTRL" || part == "CONTROL" ? Control : part == "ALT" ? Alt : part == "SHIFT" ? Shift : 0;
        if (bit) { if (!key.empty() || (modifiers & bit)) return false; modifiers |= bit; }
        else { if (part.empty() || !key.empty()) return false; key = part; }
    }
    if (text.back() == '+' || !(modifiers & (Control | Alt))) return false;
    int vk = 0;
    if (key.size() == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9'))) vk = key[0];
    else for (int i = 1; i <= 12; ++i) if (key == "F" + std::to_string(i)) vk = 0x70 + i - 1;
    if (!vk || (modifiers == Control && std::string("ACVXYZ").find(static_cast<char>(vk)) != std::string::npos) ||
        (modifiers == (Control | Shift) && vk == 'P') || ((modifiers & Alt) && vk == 0x73)) return false;
    result = {vk, modifiers, std::string(modifiers & Control ? "Ctrl+" : "") + (modifiers & Alt ? "Alt+" : "") + (modifiers & Shift ? "Shift+" : "") + key};
    return true;
}
inline Bindings Defaults() {
    Bindings b{}; Parse("Ctrl+G", b[Panel]); Parse("Ctrl+D", b[Selection]); Parse("Ctrl+R", b[Pause]); Parse("Ctrl+Shift+S", b[Capture]); return b;
}
inline bool ParseWire(const std::string& wire, Bindings& result) {
    if (wire.empty() || wire.size() > 256) return false;
    std::array<bool, 4> seen{}; Bindings parsed{}; std::istringstream input(wire); std::string line; int count = 0;
    while (std::getline(input, line)) {
        const auto at = line.find('='); if (at == std::string::npos) return false;
        int index = -1; for (int i = 0; i < 4; ++i) if (line.substr(0, at) == Name(i)) index = i;
        if (index < 0 || seen[index] || !Parse(line.substr(at + 1), parsed[index])) return false;
        for (int i = 0; i < 4; ++i) if (seen[i] && parsed[i].key == parsed[index].key && parsed[i].modifiers == parsed[index].modifiers) return false;
        seen[index] = true; ++count;
    }
    if (count != 4) return false;
    result = parsed; return true;
}
struct Registry { std::mutex mutex; std::map<int, Bindings> browsers; };
inline Registry& State() { static Registry state; return state; }
inline Bindings Get(int browser) {
    auto& s = State(); std::lock_guard<std::mutex> lock(s.mutex);
    auto it = s.browsers.find(browser); return it == s.browsers.end() ? Defaults() : it->second;
}
inline bool Update(int browser, const std::string& wire) {
    Bindings b{}; if (browser <= 0 || !ParseWire(wire, b)) return false;
    auto& s = State(); std::lock_guard<std::mutex> lock(s.mutex);
    if (!s.browsers.count(browser) && s.browsers.size() >= 256) s.browsers.erase(s.browsers.begin());
    s.browsers[browser] = b; return true;
}
inline Action Match(const Bindings& bindings, int key, int modifiers) {
    for (int i = 0; i < 4; ++i) if (bindings[i].key == key && bindings[i].modifiers == modifiers) return static_cast<Action>(i);
    return None;
}
}
