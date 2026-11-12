#include "question_bank.h"
#include "ai_config.h"
#include "vendor/sqlite/sqlite3.h"
#include "vendor/nlohmann/json.hpp"
#include <shlobj.h>
#include <algorithm>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <regex>
#include <stdexcept>
#include <vector>

namespace {
using Json = nlohmann::json;
constexpr int kApplicationId = 0x43585142;
// Bump when MatchText, StemText or JudgeStem change: stored normalized stems are rebuilt on open.
constexpr int kNormalizationVersion = 1;
constexpr size_t kMaxBody = 10 * 1024 * 1024;
// Word imports send a shared image once, but every stored question record keeps its own copy.
constexpr size_t kMaxImportBytes = 64 * 1024 * 1024;
struct Error : std::runtime_error { using std::runtime_error::runtime_error; };
std::mutex bankMutex;
std::unique_ptr<sqlite3, decltype(&sqlite3_close)> database(nullptr, sqlite3_close);
std::wstring connectedPath;
std::string restoreError;

std::string Utf8(const std::wstring& text) {
    if (text.empty()) return {};
    int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (!size) throw Error("路径编码无效");
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), &result[0], size, nullptr, nullptr);
    return result;
}
std::wstring DefaultPath() {
    const auto config = AiConfigPath();
    const auto separator = config.find_last_of(L"\\/");
    if (separator == std::wstring::npos) throw Error("无法定位 DLL 目录，默认题库未创建");
    return config.substr(0, separator + 1) + L"question-bank.db";
}
void Check(int code, sqlite3* db) {
    if (code != SQLITE_OK && code != SQLITE_DONE && code != SQLITE_ROW)
        throw Error(std::string("题库操作失败：") + (db ? sqlite3_errmsg(db) : "无法打开数据库"));
}
void Exec(sqlite3* db, const char* sql) { Check(sqlite3_exec(db, sql, nullptr, nullptr, nullptr), db); }
struct Statement {
    sqlite3* db;
    sqlite3_stmt* value = nullptr;
    Statement(sqlite3* db, const char* sql) : db(db) { Check(sqlite3_prepare_v2(db, sql, -1, &value, nullptr), db); }
    ~Statement() { if (value) sqlite3_finalize(value); }
    void Bind(int index, const std::string& text) { Check(sqlite3_bind_text(value, index, text.data(), static_cast<int>(text.size()), SQLITE_TRANSIENT), db); }
    void BindInt(int index, int n) { Check(sqlite3_bind_int(value, index, n), db); }
    int Step() { int code = sqlite3_step(value); Check(code, db); return code; }
    std::string Text(int col) { const auto* text = sqlite3_column_text(value, col); return text ? std::string(reinterpret_cast<const char*>(text), sqlite3_column_bytes(value, col)) : ""; }
    void Reset() { Check(sqlite3_reset(value), db); Check(sqlite3_clear_bindings(value), db); }
};
int Scalar(sqlite3* db, const char* sql) { Statement s(db, sql); s.Step(); return sqlite3_column_int(s.value, 0); }
std::string MatchText(const std::string& text) {
    if (text.empty()) return {};
    std::wstring wide, normalized;
    if (!ScriptUtf8ToWide(text, wide)) throw Error("题目编码无效");
    for (const auto& marker : { std::wstring(L"[图片:"), std::wstring(L"[附图]") }) {
        size_t at = 0;
        while ((at = wide.find(marker, at)) != std::wstring::npos) {
            const auto end = wide.find(L']', at);
            if (end == std::wstring::npos) break;
            wide.erase(at, end - at + 1);
        }
    }
    bool space = false;
    for (wchar_t ch : wide) {
        // Width differences from Word/exported banks do not change the question.
        if (ch >= 0xff01 && ch <= 0xff5e) ch -= 0xfee0;
        if (ch == 0x200b || ch == 0xfeff || ch == 0x2060 || ch == 0x00ad) continue;
        if (ch == 0x3002) ch = L'.';
        if (ch == 0x2018 || ch == 0x2019) ch = L'\'';
        if (ch == 0x201c || ch == 0x201d) ch = L'"';
        if (ch == L' ' || (ch >= 9 && ch <= 13) || ch == 0xa0 || ch == 0x3000 || (ch >= 0x2000 && ch <= 0x200a) || ch == 0x202f) { space = !normalized.empty(); continue; }
        if (space) normalized += L' ';
        space = false; normalized += ch;
    }
    // Preserve word boundaries ("a b" != "ab"), but ignore layout spacing
    // around Chinese characters and punctuation, e.g. "IP 网络" / "IP网络".
    auto word = [](wchar_t ch) { return (ch >= L'a' && ch <= L'z') || (ch >= L'A' && ch <= L'Z') || (ch >= L'0' && ch <= L'9') || ch == L'_'; };
    std::wstring compact;
    for (size_t i = 0; i < normalized.size(); ++i) {
        if (normalized[i] == L' ' && (i == 0 || i + 1 == normalized.size() || !word(normalized[i - 1]) || !word(normalized[i + 1]))) continue;
        compact += normalized[i];
    }
    return Utf8(compact);
}
std::string OptionText(const std::string& text) {
    auto value = MatchText(text);
    // Chaoxing renders a literal trailing <URL> as an empty HTML element.
    // Limit this compatibility projection to curl's URL placeholder; never
    // remove arbitrary tags, arguments, comparison operators or real URLs.
    if (value.rfind("`curl", 0) == 0 || value.rfind("curl", 0) == 0) {
        static const std::regex placeholder(R"(<URL>(`?)$)");
        value = std::regex_replace(value, placeholder, "$1");
    }
    return value;
}
void TrimClosingPunctuation(std::wstring& text) {
    while (!text.empty() && (text.back() == L'?' || text.back() == L'.')) text.pop_back();
}
std::string StemText(const std::string& text) {
    auto normalized = MatchText(text);
    if (normalized.empty()) return {};
    std::wstring wide;
    if (!ScriptUtf8ToWide(normalized, wide)) throw Error("题目编码无效");
    static const std::wregex labels(LR"(^((第)?[0-9]+[.、:]?)?([\(【\[])(单选题|多选题|判断题|填空题|简答题|问答题|论述题|编程题|程序设计题)(,[0-9]+(\.[0-9]+)?分)?[\)】\]])");
    while (std::regex_search(wide, labels)) wide = std::regex_replace(wide, labels, L"");
    static const std::wregex emptyBlank(LR"(\(\s+\))");
    static const std::wregex underline(LR"(_{2,})");
    wide = std::regex_replace(wide, emptyBlank, L"()");
    wide = std::regex_replace(wide, underline, L"__");
    TrimClosingPunctuation(wide);
    return MatchText(Utf8(wide));
}
std::string JudgeStem(const std::string& text) {
    auto normalized = StemText(text);
    if (normalized.empty()) return {};
    std::wstring wide;
    if (!ScriptUtf8ToWide(normalized, wide)) throw Error("题目编码无效");
    // A marked answer at the end of an exported proposition is not part of the proposition.
    static const std::wregex marked(LR"(\s*[（(]\s*(正确|错误|对|错|true|false|T|F|√|×)?\s*[）)]\s*[。.]?\s*$)", std::regex_constants::icase);
    wide = std::regex_replace(wide, marked, L"");
    TrimClosingPunctuation(wide);
    return MatchText(Utf8(wide));
}
struct Progress {
    sqlite3* db;
    const std::atomic<bool>& canceled;
    ULONGLONG started = GetTickCount64();
    Progress(sqlite3* db, const std::atomic<bool>& canceled) : db(db), canceled(canceled) {
        sqlite3_progress_handler(db, 10000, [](void* data) -> int {
            auto* self = static_cast<Progress*>(data);
            return self->canceled.load() || GetTickCount64() - self->started > 60000;
        }, this);
    }
    ~Progress() { sqlite3_progress_handler(db, 0, nullptr, nullptr); }
};
void RefreshNormalizedStems(sqlite3* db) {
    const bool tracked = Scalar(db, "SELECT count(*) FROM pragma_table_info('bank_meta') WHERE name='normalization'") != 0;
    if (tracked && Scalar(db, "SELECT normalization FROM bank_meta WHERE id=1") == kNormalizationVersion) return;
    Exec(db, "BEGIN IMMEDIATE");
    try {
        if (!tracked) Exec(db, "ALTER TABLE bank_meta ADD COLUMN normalization INTEGER NOT NULL DEFAULT 0");
        Exec(db, "UPDATE questions SET normalized_stem=CASE WHEN type='boolean' THEN cef_judge_stem(stem) ELSE cef_stem(stem) END");
        Statement version(db, "UPDATE bank_meta SET normalization=? WHERE id=1");
        version.BindInt(1, kNormalizationVersion); version.Step();
        Exec(db, "COMMIT");
    } catch (...) { sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr); throw; }
}
void OpenPath(const std::wstring& path) {
    const bool create = true;
    sqlite3* raw = nullptr;
    const auto filename = Utf8(path);
    int rc = sqlite3_open_v2(filename.c_str(), &raw, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | (create ? SQLITE_OPEN_CREATE : 0), nullptr);
    std::unique_ptr<sqlite3, decltype(&sqlite3_close)> next(raw, sqlite3_close);
    Check(rc, raw);
    sqlite3_busy_timeout(raw, 3000);
    // A conflict history row holds three question records, each from a bounded import.
    sqlite3_limit(raw, SQLITE_LIMIT_LENGTH, 32 * 1024 * 1024);
    sqlite3_db_config(raw, SQLITE_DBCONFIG_DEFENSIVE, 1, nullptr);
    sqlite3_db_config(raw, SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, nullptr);
    Check(sqlite3_create_function_v2(raw, "cef_stem", 1, SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS, nullptr,
        [](sqlite3_context* ctx, int, sqlite3_value** args) {
            try {
                const auto* value = sqlite3_value_text(args[0]);
                auto normalized = StemText(value ? reinterpret_cast<const char*>(value) : "");
                sqlite3_result_text(ctx, normalized.data(), static_cast<int>(normalized.size()), SQLITE_TRANSIENT);
            } catch (...) { sqlite3_result_error(ctx, "Invalid question text", -1); }
        }, nullptr, nullptr, nullptr), raw);
    Check(sqlite3_create_function_v2(raw, "cef_judge_stem", 1, SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS, nullptr,
        [](sqlite3_context* ctx, int, sqlite3_value** args) {
            try {
                const auto* value = sqlite3_value_text(args[0]);
                const auto normalized = JudgeStem(value ? reinterpret_cast<const char*>(value) : "");
                sqlite3_result_text(ctx, normalized.data(), static_cast<int>(normalized.size()), SQLITE_TRANSIENT);
            } catch (...) { sqlite3_result_error(ctx, "Invalid question text", -1); }
        }, nullptr, nullptr, nullptr), raw);
    int app = Scalar(raw, "PRAGMA application_id"), version = Scalar(raw, "PRAGMA user_version");
    if (create && app == 0 && version == 0 && Scalar(raw, "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'") == 0) {
        Exec(raw, "BEGIN IMMEDIATE");
        try {
            Exec(raw, "CREATE TABLE questions(id INTEGER PRIMARY KEY,bank TEXT NOT NULL,identity TEXT NOT NULL,type TEXT NOT NULL,stem TEXT NOT NULL,options TEXT NOT NULL,answer TEXT NOT NULL,explanation TEXT NOT NULL,tags TEXT NOT NULL,source TEXT NOT NULL,record TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(bank,identity));"
                      "CREATE INDEX question_bank_name ON questions(bank);"
                      "CREATE TABLE conflicts(id INTEGER PRIMARY KEY,question_id INTEGER NOT NULL REFERENCES questions(id),incoming TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(question_id,incoming));"
                      "PRAGMA application_id=0x43585142; PRAGMA user_version=1; COMMIT;");
        } catch (...) { sqlite3_exec(raw, "ROLLBACK", nullptr, nullptr, nullptr); throw; }
        app = kApplicationId; version = 1;
    }
    if (app != kApplicationId || (version != 1 && version != 2)) throw Error("目录中的 question-bank.db 格式不兼容，请保留原文件并转换成 JSON 后导入");
    { Statement schema(raw, "SELECT bank,identity,type,stem,options,answer,explanation,tags,source,record,created_at FROM questions LIMIT 0"); schema.Step(); }
    { Statement schema(raw, "SELECT question_id,incoming FROM conflicts LIMIT 0"); schema.Step(); }
    // Never run triggers supplied by an imported database during later inserts.
    if (Scalar(raw, "SELECT count(*) FROM sqlite_master WHERE type IN ('trigger','view')") != 0) throw Error("题库包含不支持的触发器或视图");
    if (version == 1) {
        Exec(raw, "BEGIN IMMEDIATE");
        try {
            Exec(raw, "ALTER TABLE questions ADD COLUMN normalized_stem TEXT NOT NULL DEFAULT '';"
                "ALTER TABLE questions ADD COLUMN record_lite TEXT NOT NULL DEFAULT '{}';"
                "ALTER TABLE questions ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0;"
                "ALTER TABLE questions ADD COLUMN has_images INTEGER NOT NULL DEFAULT 0;"
                "UPDATE questions SET record_lite=json_remove(record,'$.images'),image_count=coalesce(json_array_length(record,'$.images'),0),"
                "has_images=(instr(stem,'[图片:')>0 OR instr(options,'[图片:')>0);"
                "CREATE INDEX question_match_stem ON questions(type,normalized_stem);"
                "CREATE INDEX question_match_image ON questions(type,has_images);"
                "CREATE INDEX question_bank_page ON questions(bank,id);"
                "CREATE TABLE bank_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,normalization INTEGER NOT NULL DEFAULT 0);"
                "INSERT INTO bank_meta(id,revision) VALUES(1,0);"
                "CREATE TABLE conflict_history(id INTEGER PRIMARY KEY,question_id INTEGER NOT NULL,bank TEXT NOT NULL,decision TEXT NOT NULL,previous TEXT NOT NULL,incoming TEXT NOT NULL,resolved TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);"
                "PRAGMA user_version=2; COMMIT;");
        } catch (...) { sqlite3_exec(raw, "ROLLBACK", nullptr, nullptr, nullptr); throw; }
    }
    RefreshNormalizedStems(raw);
    database.swap(next); connectedPath = path; restoreError.clear();
}
void OpenDefault() { OpenPath(DefaultPath()); }
void MigrateDefault() {
    const auto target = DefaultPath();
    if (GetFileAttributesW(target.c_str()) != INVALID_FILE_ATTRIBUTES) return;
    wchar_t local[MAX_PATH]{};
    if (FAILED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, SHGFP_TYPE_CURRENT, local))) return;
    const auto legacy = std::wstring(local) + L"\\cef_ex_copy_tool\\question-bank.db";
    if (GetFileAttributesW(legacy.c_str()) == INVALID_FILE_ATTRIBUTES) return;
    sqlite3* raw = nullptr;
    int rc = sqlite3_open_v2(Utf8(legacy).c_str(), &raw, SQLITE_OPEN_READONLY, nullptr);
    std::unique_ptr<sqlite3, decltype(&sqlite3_close)> source(raw, sqlite3_close);
    Check(rc, raw); sqlite3_busy_timeout(raw, 3000);
    if (Scalar(raw, "PRAGMA application_id") != kApplicationId || (Scalar(raw, "PRAGMA user_version") != 1 && Scalar(raw, "PRAGMA user_version") != 2))
        throw Error("旧默认题库格式不兼容，原文件已保留，请转换成 JSON 后导入");
    const auto temporary = target + L".migrate-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    try {
        sqlite3* destinationRaw = nullptr;
        rc = sqlite3_open_v2(Utf8(temporary).c_str(), &destinationRaw, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr);
        std::unique_ptr<sqlite3, decltype(&sqlite3_close)> destination(destinationRaw, sqlite3_close);
        Check(rc, destinationRaw);
        sqlite3_busy_timeout(destinationRaw, 3000);
        auto* backup = sqlite3_backup_init(destinationRaw, "main", raw, "main");
        if (!backup) throw Error("无法迁移旧题库，旧数据仍保留在原位置");
        rc = sqlite3_backup_step(backup, -1);
        int finished = sqlite3_backup_finish(backup);
        Check(rc, destinationRaw); Check(finished, destinationRaw);
        destination.reset();
        // No replacement: another process or the user may already have created the target.
        if (!MoveFileExW(temporary.c_str(), target.c_str(), MOVEFILE_WRITE_THROUGH)) {
            const DWORD error = GetLastError();
            if (error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) throw Error("无法写入 DLL 目录，旧题库仍保留在原位置");
            DeleteFileW(temporary.c_str());
        }
    } catch (...) { DeleteFileW(temporary.c_str()); throw; }
}
void EnsureDefault() {
    if (database) return;
    try {
        MigrateDefault();
        OpenDefault();
    } catch (const std::exception& error) { restoreError = std::string("默认题库打开失败：") + error.what(); }
}
Json Status() {
    Json result{{"ok", true}, {"connected", !!database}, {"path", Utf8(connectedPath)}, {"defaultPath", Utf8(DefaultPath())}, {"count", 0}, {"conflicts", 0}, {"schemaVersion", 2}};
    if (database) {
        result["count"] = Scalar(database.get(), "SELECT count(*) FROM questions");
        result["conflicts"] = Scalar(database.get(), "SELECT count(*) FROM conflicts");
        result["revision"] = Scalar(database.get(), "SELECT revision FROM bank_meta WHERE id=1");
        result["banks"] = Json::array();
        Statement banks(database.get(), "SELECT bank,count(*) FROM questions GROUP BY bank ORDER BY bank");
        while (banks.Step() == SQLITE_ROW) result["banks"].push_back(Json{{"name", banks.Text(0)}, {"count", sqlite3_column_int(banks.value, 1)}});
    }
    if (!restoreError.empty()) result["connectionError"] = restoreError;
    return result;
}
std::string Text(const Json& object, const char* name, size_t limit, bool required = false) {
    if (!object.contains(name)) { if (required) throw Error(std::string("缺少字段：") + name); return ""; }
    if (!object[name].is_string()) throw Error(std::string("字段必须是字符串：") + name);
    auto value = object[name].get<std::string>();
    if (value.size() > limit || value.find('\0') != std::string::npos || (required && value.find_first_not_of(" \r\n\t") == std::string::npos)) throw Error(std::string("字段为空或过长：") + name);
    return value;
}
const std::regex& ImageReferencePattern();
bool HasAnswerText(const Json& answer, size_t limit) {
    if (!answer.is_string()) return false;
    const auto& value = answer.get_ref<const std::string&>();
    if (value.size() > limit) return false;
    const auto first = value.find_first_not_of(" \t\r\n\f\v");
    if (first == std::string::npos) return false;
    if (static_cast<unsigned char>(value[first]) < 0x80) return true;
    std::wstring wide;
    if (!ScriptUtf8ToWide(value, wide)) return false;
    return std::any_of(wide.begin(), wide.end(), [](wchar_t ch) {
        // Match the whitespace trimmed by the page before filling an answer.
        return !(ch == L' ' || (ch >= 9 && ch <= 13) || ch == 0xa0 || ch == 0x1680 ||
            (ch >= 0x2000 && ch <= 0x200a) || ch == 0x2028 || ch == 0x2029 ||
            ch == 0x202f || ch == 0x205f || ch == 0x3000 || ch == 0xfeff);
    });
}
Json Validate(const Json& q, const Json* sharedImages = nullptr) {
    if (!q.is_object()) throw Error("题目必须是 JSON 对象");
    Json result;
    result["id"] = Text(q, "id", 256);
    result["type"] = Text(q, "type", 20, true);
    result["stem"] = Text(q, "stem", 64000, true);
    result["explanation"] = Text(q, "explanation", 128000);
    result["source"] = Text(q, "source", 2048);
    result["options"] = q.value("options", Json::array());
    result["tags"] = q.value("tags", Json::array());
    std::set<std::string> imageIds;
    if (q.contains("images") && !q["images"].empty()) {
        if (!q["images"].is_array() || q["images"].size() > 32) throw Error("每题图片最多 32 张");
        size_t bytes = 0;
        result["images"] = Json::array();
        for (const auto& image : q["images"]) {
            if (!image.is_object()) throw Error("题图格式无效");
            auto id = Text(image, "id", 128, true);
            auto data = sharedImages && !image.contains("dataUrl")
                ? Text(*sharedImages, id.c_str(), 6 * 1024 * 1024, true)
                : Text(image, "dataUrl", 6 * 1024 * 1024, true);
            if (!imageIds.insert(id).second) throw Error("题图 ID 重复");
            const auto comma = data.find(',');
            if (comma == std::string::npos || (data.substr(0, comma) != "data:image/png;base64" && data.substr(0, comma) != "data:image/jpeg;base64" && data.substr(0, comma) != "data:image/gif;base64" && data.substr(0, comma) != "data:image/webp;base64") ||
                data.size() <= comma + 1 || data.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=", comma + 1) != std::string::npos) throw Error("题图仅支持 PNG/JPEG/GIF/WebP 的 base64 数据");
            bytes += data.size(); if (bytes > 8 * 1024 * 1024) throw Error("单题图片数据过大");
            result["images"].push_back(Json{{"id", id}, {"dataUrl", data}});
        }
    }
    if (!result["tags"].is_array() || result["tags"].size() > 32) throw Error("tags 必须是最多 32 项的数组");
    for (const auto& tag : result["tags"]) if (!tag.is_string() || tag.get<std::string>().size() > 256) throw Error("标签格式无效");
    if (!result["options"].is_array() || result["options"].size() > 64) throw Error("options 必须是最多 64 项的数组");
    std::set<std::string> ids;
    for (auto& option : result["options"]) {
        if (!option.is_object()) throw Error("选项必须包含 id 和 text");
        auto id = Text(option, "id", 128, true), text = Text(option, "text", 16000, true);
        if (!ids.insert(id).second) throw Error("选项 ID 重复");
        option = Json{{"id", id}, {"text", text}};
    }
    if (!q.contains("answer")) throw Error("缺少 answer 字段");
    auto answer = q["answer"];
    const auto type = result["type"].get<std::string>();
    if (type == "single" || type == "multiple") {
        if (ids.size() < 2 || !answer.is_array() || answer.empty() || (type == "single" && answer.size() != 1)) throw Error("选择题答案必须是选项 ID 数组，单选只能有一个答案");
        std::set<std::string> selected;
        for (const auto& id : answer) {
            if (!id.is_string() || !ids.count(id.get<std::string>()) || !selected.insert(id.get<std::string>()).second) throw Error("答案包含不存在或重复的选项 ID");
        }
        std::sort(answer.begin(), answer.end());
    } else if (type == "boolean") {
        if (!answer.is_boolean()) throw Error("判断题 answer 必须是 true 或 false");
    } else if (type == "blank") {
        if (!answer.is_array() || answer.empty() || answer.size() > 64) throw Error("填空题答案必须是按空排列的数组");
        for (const auto& blank : answer) {
            if (!blank.is_array() || blank.empty() || blank.size() > 32) throw Error("每个空必须有一个可接受答案数组");
            for (const auto& variant : blank) if (!HasAnswerText(variant, 16000)) throw Error("填空答案必须是非空文字");
        }
    } else if (type == "text") {
        if (!HasAnswerText(answer, 128000)) throw Error("简答题答案必须是非空文字");
    } else throw Error("不支持的题型：使用 single、multiple、boolean、blank 或 text");
    auto checkImages = [&](const auto& check, const Json& field) -> void {
        if (field.is_array()) {
            for (const auto& item : field) check(check, item);
        } else if (field.is_string()) {
            const auto& text = field.get_ref<const std::string&>();
            for (std::sregex_iterator ref(text.begin(), text.end(), ImageReferencePattern()), end; ref != end; ++ref) {
                const auto id = (*ref)[1].str();
                if (!imageIds.count(id)) throw Error("缺少图片附件：[图片:" + id + "]");
            }
        }
    };
    checkImages(checkImages, result["stem"]);
    for (const auto& option : result["options"]) checkImages(checkImages, option["text"]);
    if (type == "blank" || type == "text") checkImages(checkImages, answer);
    checkImages(checkImages, result["explanation"]);
    result["answer"] = std::move(answer);
    return result;
}
std::string Identity(const Json& q) {
    auto id = q["id"].get<std::string>();
    return id.empty() ? "content:" + Json::array({q["type"], q["stem"], q["options"]}).dump() : "id:" + id;
}
const std::regex& ImageReferencePattern() {
    static const std::regex pattern(R"(\[图片:([^\]]+)\])");
    return pattern;
}
std::set<std::string> QuestionImageIds(const Json& q) {
    std::set<std::string> ids;
    auto collect = [&](const Json& field) {
        const auto& text = field.get_ref<const std::string&>();
        for (std::sregex_iterator ref(text.begin(), text.end(), ImageReferencePattern()), end; ref != end; ++ref)
            ids.insert((*ref)[1].str());
    };
    collect(q.at("stem"));
    for (const auto& option : q.at("options")) collect(option.at("text"));
    return ids;
}
std::vector<const Json*> ReferencedQuestionImages(const Json& q, const std::set<std::string>& ids) {
    std::vector<const Json*> images;
    if (q.contains("images")) for (const auto& image : q["images"]) {
        if (ids.count(image.at("id").get_ref<const std::string&>())) images.push_back(&image);
    }
    return images;
}
template<class Rename>
void RewriteImageReferences(Json& field, const Rename& rename) {
    if (field.is_array()) {
        for (auto& item : field) RewriteImageReferences(item, rename);
    } else if (field.is_string()) {
        const auto& text = field.get_ref<const std::string&>();
        std::sregex_iterator ref(text.begin(), text.end(), ImageReferencePattern()), end;
        if (ref == end) return;
        std::string rewritten;
        size_t offset = 0;
        for (; ref != end; ++ref) {
            const auto start = static_cast<size_t>(ref->position(1));
            rewritten.append(text, offset, start - offset);
            rewritten += rename((*ref)[1].str());
            offset = start + ref->length(1);
        }
        rewritten.append(text, offset);
        field = std::move(rewritten);
    }
}
void NormalizeImageIds(Json& q) {
    if (!q.contains("images")) return;
    auto& assets = q["images"];
    std::map<std::string, size_t> originals;
    std::map<std::string, std::string> localIds;
    for (size_t i = 0; i < assets.size(); ++i) originals.emplace(assets[i]["id"].get<std::string>(), i);
    Json ordered = Json::array();
    auto rename = [&](const std::string& id) -> std::string {
        const auto original = originals.find(id);
        if (original == originals.end()) return id;
        auto& local = localIds[id];
        if (local.empty()) {
            local = "img" + std::to_string(ordered.size() + 1);
            auto& asset = assets[original->second];
            asset["id"] = local;
            ordered.push_back(std::move(asset));
        }
        return local;
    };
    RewriteImageReferences(q["stem"], rename);
    for (auto& option : q["options"]) RewriteImageReferences(option["text"], rename);
    if (q["type"] == "blank" || q["type"] == "text") RewriteImageReferences(q["answer"], rename);
    RewriteImageReferences(q["explanation"], rename);
    for (const auto& asset : assets) if (!asset.is_null()) rename(asset["id"].get<std::string>());
    assets = std::move(ordered);
}
void RefreshDerived(sqlite3* db, int64_t firstId, int64_t lastId) {
    Statement update(db, "UPDATE questions SET normalized_stem=CASE WHEN type='boolean' THEN cef_judge_stem(stem) ELSE cef_stem(stem) END,"
        "record_lite=json_remove(record,'$.images'),image_count=coalesce(json_array_length(record,'$.images'),0),"
        "has_images=(instr(stem,'[图片:')>0 OR instr(options,'[图片:')>0) WHERE id BETWEEN ? AND ?");
    Check(sqlite3_bind_int64(update.value, 1, firstId), db);
    Check(sqlite3_bind_int64(update.value, 2, lastId), db);
    update.Step();
}
Json Import(const Json& input, const std::atomic<bool>& canceled, bool preview) {
    if (!database) throw Error("默认题库尚未就绪，请检查 DLL 目录写入权限后重新打开题库页");
    const auto& payload = input.at("payload");
    const auto expectedRevision = input.value("revision", int64_t(-1));
    if (!payload.is_object() || payload.value("schemaVersion", 0) != 1) throw Error("题库 JSON 的 schemaVersion 必须为 1");
    auto name = Text(payload, "name", 256, true);
    if (!payload.contains("questions") || !payload["questions"].is_array() || payload["questions"].empty() || payload["questions"].size() > 10000) throw Error("每次导入应包含 1 至 10000 道题");
    const Json* sharedImages = nullptr;
    if (input.value("format", std::string()) == "docx" && payload.contains("sharedImages")) {
        sharedImages = &payload["sharedImages"];
        if (!sharedImages->is_object()) throw Error("Word 共用图片格式无效");
    }
    int inserted = 0, duplicates = 0, conflicts = 0, index = 0, errors = 0, images = 0, previewRevision = 0;
    int64_t firstInsertedId = 0, lastInsertedId = 0;
    size_t storedBytes = 0;
    Json issues = Json::array(), samples = Json::array(), types = Json::object();
    auto* db = database.get();
    Progress progress(db, canceled);
    Exec(db, "BEGIN IMMEDIATE");
    try {
        previewRevision = Scalar(db, "SELECT revision FROM bank_meta WHERE id=1");
        if (!preview && expectedRevision >= 0 && expectedRevision != previewRevision) throw Error("题库在预览后已变化，请重新选择文件预检");
        Statement find(db, "SELECT id,record FROM questions WHERE bank=? AND identity=?");
        Statement findImages(db, "SELECT id,record FROM questions WHERE bank=? AND type=? AND normalized_stem=? AND has_images=1 ORDER BY id");
        Statement insert(db, "INSERT INTO questions(bank,identity,type,stem,options,answer,explanation,tags,source,record,normalized_stem,has_images)"
            " VALUES(?1,COALESCE(?2,'image:'||(SELECT COALESCE(MAX(id),0)+1 FROM questions)),?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)");
        // The bank revision also bounds issued conflict IDs after their rows are resolved.
        Statement conflict(db, "INSERT OR IGNORE INTO conflicts(id,question_id,incoming) VALUES("
            "1+MAX((SELECT revision FROM bank_meta WHERE id=1),COALESCE((SELECT MAX(id) FROM conflicts),0)),?,?)");
        Statement pending(db, "SELECT incoming FROM conflicts WHERE question_id=?");
        for (const auto& item : payload["questions"]) {
            ++index;
            if (canceled.load()) throw Error("导入已取消，本次数据未写入");
            Json q;
            try { q = Validate(item, sharedImages); }
            catch (const std::exception& error) {
                if (!preview) throw;
                ++errors;
                if (issues.size() < 1000) issues.push_back(Json{{"index", index}, {"error", error.what()}});
                continue;
            }
            NormalizeImageIds(q);
            images += q.value("images", Json::array()).size();
            auto type = q["type"].get<std::string>(); types[type] = types.value(type, 0) + 1;
            if (samples.size() < 20) { auto sample = q; sample.erase("images"); sample["index"] = index; samples.push_back(sample); }
            const auto& stem = q["stem"].get_ref<const std::string&>();
            const auto normalizedStem = type == "boolean" ? JudgeStem(stem) : StemText(stem);
            const auto imageIds = q.contains("images") ? QuestionImageIds(q) : std::set<std::string>();
            const auto questionImages = ReferencedQuestionImages(q, imageIds);
            const bool byImage = q["id"] == "" && !questionImages.empty();
            const auto identity = byImage ? std::string() : Identity(q);
            const auto record = q.dump();
            int64_t existingId = 0;
            bool sameRecord = false;
            if (byImage) {
                findImages.Bind(1, name); findImages.Bind(2, type); findImages.Bind(3, normalizedStem);
                while (findImages.Step() == SQLITE_ROW) {
                    auto current = Json::parse(findImages.Text(1));
                    if (current["id"] != "") continue;
                    NormalizeImageIds(current);
                    if (current["stem"] != q["stem"] || current["options"] != q["options"]) continue;
                    const auto currentImages = ReferencedQuestionImages(current, imageIds);
                    if (!std::equal(questionImages.begin(), questionImages.end(), currentImages.begin(), currentImages.end(),
                        [](const Json* left, const Json* right) { return *left == *right; })) continue;
                    existingId = sqlite3_column_int64(findImages.value, 0);
                    sameRecord = current == q;
                    break;
                }
                findImages.Reset();
            } else {
                find.Bind(1, name); find.Bind(2, identity);
                if (find.Step() == SQLITE_ROW) {
                    existingId = sqlite3_column_int64(find.value, 0);
                    const auto existing = find.Text(1);
                    sameRecord = existing == record;
                    if (!sameRecord && q.contains("images")) {
                        auto current = Json::parse(existing); NormalizeImageIds(current);
                        sameRecord = current == q;
                    }
                }
                find.Reset();
            }
            if (existingId && !sameRecord && q.contains("images")) {
                Check(sqlite3_bind_int64(pending.value, 1, existingId), db);
                while (pending.Step() == SQLITE_ROW) {
                    const auto stored = pending.Text(0);
                    if (stored == record) { sameRecord = true; break; }
                    auto incoming = Json::parse(stored); NormalizeImageIds(incoming);
                    if (incoming == q) { sameRecord = true; break; }
                }
                pending.Reset();
            }
            if (sameRecord) ++duplicates;
            else if (existingId) {
                Check(sqlite3_bind_int64(conflict.value, 1, existingId), db);
                conflict.Bind(2, record); conflict.Step();
                if (sqlite3_changes(db)) { ++conflicts; storedBytes += record.size(); }
                else ++duplicates;
                conflict.Reset();
            } else {
                insert.Bind(1, name);
                if (!byImage) insert.Bind(2, identity);
                insert.Bind(3, type); insert.Bind(4, stem);
                insert.Bind(5, q["options"].dump()); insert.Bind(6, q["answer"].dump()); insert.Bind(7, q["explanation"].get<std::string>());
                insert.Bind(8, q["tags"].dump()); insert.Bind(9, q["source"].get<std::string>()); insert.Bind(10, record);
                insert.Bind(11, normalizedStem); insert.BindInt(12, !imageIds.empty());
                insert.Step();
                lastInsertedId = sqlite3_last_insert_rowid(db);
                if (!inserted) firstInsertedId = lastInsertedId;
                insert.Reset(); ++inserted; storedBytes += record.size();
            }
            if (storedBytes > kMaxImportBytes) throw Error("本次导入写入的数据超过 64 MiB（Word 中多道题共用的图片会按题分别保存），请拆分文档后导入");
        }
        if (canceled.load()) throw Error("导入已取消，本次数据未写入");
        if (preview) Exec(db, "ROLLBACK");
        else {
            if (inserted) RefreshDerived(db, firstInsertedId, lastInsertedId);
            if (inserted || conflicts) Exec(db, "UPDATE bank_meta SET revision=MAX(revision+1,COALESCE((SELECT MAX(id) FROM conflicts),0)) WHERE id=1");
            Exec(db, "COMMIT");
        }
    } catch (const std::exception& error) {
        sqlite3_progress_handler(db, 0, nullptr, nullptr);
        sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
        throw Error((index ? "第 " + std::to_string(index) + " 道题：" : std::string()) + error.what() + "；本次导入已回滚");
    }
    auto result = Status(); result["inserted"] = inserted; result["duplicates"] = duplicates; result["importConflicts"] = conflicts;
    if (preview) result["revision"] = previewRevision;
    result["preview"] = preview; result["valid"] = errors == 0; result["errors"] = issues; result["errorCount"] = errors;
    result["samples"] = samples; result["types"] = types; result["images"] = images; result["total"] = payload["questions"].size();
    return result;
}
Json Search(const Json& input, const std::atomic<bool>& canceled) {
    if (!database) throw Error("默认题库尚未就绪，请重新打开题库页查看原因");
    auto query = Text(input, "query", 512 * 3); // UTF-8 bytes for up to 512 UTF-16 code units in the search box.
    auto* db = database.get();
    Progress progress(db, canceled);
    auto bank = Text(input, "bank", 256), type = Text(input, "type", 20), tag = Text(input, "tag", 256);
    auto before = input.value("before", int64_t(0));
    const int pageSize = (std::max)(1, (std::min)(50, input.value("pageSize", 20)));
    std::string sql = "SELECT id,bank,type,substr(stem,1,600),image_count FROM questions WHERE instr(lower(stem),lower(?))>0";
    if (!bank.empty()) sql += " AND bank=?";
    if (!type.empty()) sql += " AND type=?";
    if (!tag.empty()) sql += " AND EXISTS(SELECT 1 FROM json_each(questions.tags) WHERE value=?)";
    if (before > 0) sql += " AND id<?";
    sql += " ORDER BY id DESC LIMIT ?";
    Statement s(db, sql.c_str()); int binding = 1;
    s.Bind(binding++, query);
    if (!bank.empty()) s.Bind(binding++, bank);
    if (!type.empty()) s.Bind(binding++, type);
    if (!tag.empty()) s.Bind(binding++, tag);
    if (before > 0) Check(sqlite3_bind_int64(s.value, binding++, before), db);
    s.BindInt(binding, pageSize + 1);
    Json rows = Json::array(); bool more = false; int64_t cursor = 0;
    while (s.Step() == SQLITE_ROW) {
        if (canceled.load()) throw Error("查询已取消");
        if (rows.size() >= pageSize) { more = true; break; }
        cursor = sqlite3_column_int64(s.value, 0);
        rows.push_back(Json{{"dbId", cursor}, {"bank", s.Text(1)}, {"type", s.Text(2)}, {"stem", s.Text(3)}, {"imageCount", sqlite3_column_int(s.value, 4)}});
    }
    return Json{{"ok", true}, {"questions", rows}, {"more", more}, {"nextCursor", cursor}};
}
Json Detail(const Json& input) {
    Statement s(database.get(), input.value("images", false)
        ? "SELECT bank,record,image_count FROM questions WHERE id=?"
        : "SELECT bank,record_lite,image_count FROM questions WHERE id=?");
    Check(sqlite3_bind_int64(s.value, 1, input.at("id").get<int64_t>()), database.get());
    if (s.Step() != SQLITE_ROW) throw Error("题目已不存在，请刷新列表");
    auto q = Json::parse(s.Text(1)); q["dbId"] = input["id"]; q["bank"] = s.Text(0); q["imageCount"] = sqlite3_column_int(s.value, 2);
    return Json{{"ok", true}, {"question", q}, {"revision", Scalar(database.get(), "SELECT revision FROM bank_meta WHERE id=1")}};
}
Json Images(const Json& input) {
    if (input.contains("revision") && input["revision"] != Scalar(database.get(), "SELECT revision FROM bank_meta WHERE id=1"))
        return Json{{"ok", false}, {"code", "BANK_REVISION"}, {"error", "题库已变化，请重新查询"}};
    Statement s(database.get(), "SELECT json_extract(record,'$.images'),record_lite FROM questions WHERE id=?");
    Check(sqlite3_bind_int64(s.value, 1, input.at("id").get<int64_t>()), database.get());
    if (s.Step() != SQLITE_ROW) throw Error("题目已不存在，请刷新列表");
    const auto encoded = s.Text(0);
    auto images = encoded.empty() ? Json::array() : Json::parse(encoded);
    if (input.value("questionOnly", false)) {
        const auto ids = QuestionImageIds(Json::parse(s.Text(1)));
        Json visible = Json::array();
        for (auto& image : images) if (ids.count(image.at("id").get_ref<const std::string&>())) visible.push_back(std::move(image));
        images = std::move(visible);
    }
    return Json{{"ok", true}, {"images", std::move(images)}};
}
Json Conflicts(const Json& input) {
    auto bank = Text(input, "bank", 256);
    const auto revision = Scalar(database.get(), "SELECT revision FROM bank_meta WHERE id=1");
    const bool restarted = input.value("revision", revision) != revision;
    const auto after = restarted ? 0 : input.value("after", int64_t(0));
    Statement s(database.get(), "SELECT c.id,q.id,q.bank,substr(q.stem,1,600) FROM conflicts c JOIN questions q ON q.id=c.question_id WHERE c.id>? AND (?='' OR q.bank=?) ORDER BY c.id LIMIT 21");
    Check(sqlite3_bind_int64(s.value, 1, after), database.get()); s.Bind(2, bank); s.Bind(3, bank);
    Json rows = Json::array(); bool more = false; int64_t cursor = 0;
    while (s.Step() == SQLITE_ROW) {
        if (rows.size() == 20) { more = true; break; }
        cursor = sqlite3_column_int64(s.value, 0);
        rows.push_back(Json{{"id", cursor}, {"dbId", sqlite3_column_int64(s.value, 1)}, {"bank", s.Text(2)}, {"stem", s.Text(3)}});
    }
    auto result = Json{{"ok", true}, {"conflicts", rows}, {"more", more}, {"nextCursor", cursor}, {"revision", revision}};
    if (restarted) result["status"] = Status();
    return result;
}
std::string ConflictRevision(int64_t questionId) {
    Statement history(database.get(), "SELECT COALESCE(MAX(id),0) FROM conflict_history WHERE question_id=? AND decision<>'keep' AND previous<>resolved");
    Check(sqlite3_bind_int64(history.value, 1, questionId), database.get());
    history.Step();
    return std::to_string(questionId) + ":" + std::to_string(sqlite3_column_int64(history.value, 0));
}
Json ConflictDetail(const Json& input) {
    Statement s(database.get(), "SELECT q.record,c.incoming,q.bank,q.id FROM conflicts c JOIN questions q ON q.id=c.question_id WHERE c.id=?");
    Check(sqlite3_bind_int64(s.value, 1, input.at("id").get<int64_t>()), database.get());
    if (s.Step() != SQLITE_ROW) throw Error("该冲突已处理，请刷新列表");
    auto old = Json::parse(s.Text(0)), incoming = Json::parse(s.Text(1));
    // Text diff is small. Images are explicitly requested when inspecting a conflict.
    if (!input.value("images", false)) { old.erase("images"); incoming.erase("images"); }
    return Json{{"ok", true}, {"current", old}, {"incoming", incoming}, {"bank", s.Text(2)},
        {"revision", ConflictRevision(sqlite3_column_int64(s.value, 3))}};
}
Json ResolveConflict(const Json& input, const std::atomic<bool>& canceled) {
    auto* db = database.get(); Progress progress(db, canceled); Exec(db, "BEGIN IMMEDIATE");
    bool questionChanged = false;
    try {
        Statement s(db, "SELECT q.id,q.bank,q.record,c.incoming FROM conflicts c JOIN questions q ON q.id=c.question_id WHERE c.id=?");
        const auto conflictId = input.at("id").get<int64_t>();
        Check(sqlite3_bind_int64(s.value, 1, conflictId), db);
        if (s.Step() != SQLITE_ROW) throw Error("该冲突已处理，请刷新列表");
        const auto id = sqlite3_column_int64(s.value, 0);
        if (input.at("revision") != ConflictRevision(id)) {
            Exec(db, "ROLLBACK");
            return Json{{"ok", false}, {"code", "BANK_REVISION"}, {"error", "原题已变化，请重新展开核对"}};
        }
        const auto bank = s.Text(1), previous = s.Text(2), incoming = s.Text(3);
        const auto decision = Text(input, "decision", 20, true);
        std::string updated;
        if (decision != "keep") {
            Json q;
            if (decision == "incoming") q = Json::parse(incoming);
            else if (decision == "manual") {
                q = input.at("question");
                // Editor changes textual fields only; preserve the original image assets.
                auto old = Json::parse(previous); if (old.contains("images")) q["images"] = old["images"];
            } else throw Error("不支持的冲突处理方式");
            q = Validate(q);
            NormalizeImageIds(q);
            updated = q.dump();
            questionChanged = updated != previous;
            const bool byImage = q["id"] == "" && !ReferencedQuestionImages(q, QuestionImageIds(q)).empty();
            const auto identity = byImage ? "image:" + std::to_string(id) : Identity(q);
            Statement duplicate(db, "SELECT 1 FROM questions WHERE bank=? AND identity=? AND id<>?");
            duplicate.Bind(1, bank); duplicate.Bind(2, identity); Check(sqlite3_bind_int64(duplicate.value, 3, id), db);
            if (duplicate.Step() == SQLITE_ROW) throw Error("处理后的题目与本题库中另一道题重复，请修改内容或保留原题");
            Statement update(db, "UPDATE questions SET identity=?,type=?,stem=?,options=?,answer=?,explanation=?,tags=?,source=?,record=? WHERE id=?");
            update.Bind(1, identity); update.Bind(2, q["type"]); update.Bind(3, q["stem"]); update.Bind(4, q["options"].dump());
            update.Bind(5, q["answer"].dump()); update.Bind(6, q["explanation"]); update.Bind(7, q["tags"].dump()); update.Bind(8, q["source"]); update.Bind(9, updated);
            Check(sqlite3_bind_int64(update.value, 10, id), db); update.Step();
            RefreshDerived(db, id, id);
        }
        Statement history(db, "INSERT INTO conflict_history(question_id,bank,decision,previous,incoming,resolved) VALUES(?,?,?,?,?,?)");
        Check(sqlite3_bind_int64(history.value, 1, id), db); history.Bind(2, bank); history.Bind(3, decision);
        history.Bind(4, previous); history.Bind(5, incoming); history.Bind(6, decision == "keep" ? previous : updated); history.Step();
        Statement remove(db, "DELETE FROM conflicts WHERE id=?"); Check(sqlite3_bind_int64(remove.value, 1, conflictId), db); remove.Step();
        if (canceled.load()) throw Error("处理已取消");
        Statement revision(db, "UPDATE bank_meta SET revision=MAX(revision+1,?) WHERE id=1");
        Check(sqlite3_bind_int64(revision.value, 1, conflictId), db); revision.Step();
        Exec(db, "COMMIT");
    } catch (...) { sqlite3_progress_handler(db, 0, nullptr, nullptr); sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr); throw; }
    auto result = Status(); result["questionChanged"] = questionChanged; return result;
}
Json Lookup(const Json& input, const std::atomic<bool>& canceled) {
    if (!database) throw Error("默认题库尚未就绪，请在题库页查看原因后重试");
    const bool hasImages = input.value("hasImages", false);
    auto type = Text(input, "type", 20, true), stem = StemText(Text(input, "stem", 64000, !hasImages));
    auto alternate = StemText(Text(input, "alternateStem", 64000));
    if (type == "boolean") { stem = JudgeStem(stem); alternate = JudgeStem(alternate); }
    const auto options = input.value("options", Json::array());
    if (!options.is_array() || options.size() > 26) throw Error("页面选项格式无效");
    std::vector<std::string> pageOptions;
    for (const auto& option : options) {
        if (!option.is_string() || option.get<std::string>().size() > 16000) throw Error("页面选项格式无效");
        pageOptions.push_back(OptionText(option.get<std::string>()));
    }
    auto* db = database.get(); Progress progress(db, canceled);
    const bool imageOnly = hasImages && alternate.empty();
    const bool compareImageOptions = hasImages && (type == "single" || type == "multiple") && !pageOptions.empty();
    auto sortedPage = pageOptions;
    if (compareImageOptions) std::sort(sortedPage.begin(), sortedPage.end());
    const auto selectedBank = Text(input, "bank", 256);
    std::string sql = "SELECT q.record_lite,q.bank,EXISTS(SELECT 1 FROM conflicts c WHERE c.question_id=q.id),q.id,q.image_count FROM questions q WHERE q.type=?";
    sql += imageOnly ? " AND q.has_images=1" : " AND q.normalized_stem IN (?,?)";
    if (!selectedBank.empty()) sql += " AND q.bank=?";
    if (hasImages && !imageOnly) sql += " AND q.has_images=1";
    sql += " ORDER BY q.id";
    Statement s(db, sql.c_str()); s.Bind(1, type); int binding = 2;
    if (!imageOnly) { s.Bind(binding++, stem); s.Bind(binding++, alternate.empty() ? stem : alternate); }
    if (!selectedBank.empty()) s.Bind(binding, selectedBank);
    Json accepted, imageCandidates = Json::array(); std::string bank, missReason = "not-found"; size_t candidateBytes = 0;
    Json review = Json::array(), matchedQuestion;
    while (s.Step() == SQLITE_ROW) {
        if (canceled.load()) throw Error("题库查询已取消");
        auto q = Json::parse(s.Text(0)); const auto dbId = sqlite3_column_int64(s.value, 3);
        if (review.size() < 8) review.push_back(Json{{"dbId", dbId}, {"bank", s.Text(1)}, {"stem", q["stem"]}});
        // Explanation/answer illustrations are not part of the visible question.
        bool questionImages = q["stem"].get<std::string>().find("[图片:") != std::string::npos;
        for (const auto& option : q["options"]) if (option["text"].get<std::string>().find("[图片:") != std::string::npos) questionImages = true;
        if (hasImages) {
            if (!questionImages || sqlite3_column_int(s.value, 4) == 0) continue;
            // Reject incompatible text options before counting candidates for pixel matching.
            if (compareImageOptions) {
                std::vector<std::string> storedOptions;
                for (const auto& option : q["options"]) storedOptions.push_back(OptionText(option["text"].get<std::string>()));
                std::sort(storedOptions.begin(), storedOptions.end());
                // The browser can recover one missing distractor from an exact-stem single choice.
                const bool missingDistractor = !imageOnly && type == "single" && storedOptions.size() == 4 && sortedPage.size() == 3 &&
                    !sortedPage.front().empty() && std::includes(storedOptions.begin(), storedOptions.end(), sortedPage.begin(), sortedPage.end());
                if (sortedPage != storedOptions && !missingDistractor) { missReason = "options-mismatch"; continue; }
            }
            candidateBytes += q.dump().size();
            if (imageCandidates.size() >= 20 || candidateBytes > 8u * 1024u * 1024u)
                return Json{{"ok", true}, {"matched", false}, {"reason", "candidate-limit"}, {"review", review}};
            imageCandidates.push_back(Json{{"question", q}, {"dbId", dbId}, {"bank", s.Text(1)}, {"conflict", sqlite3_column_int(s.value, 2) != 0}, {"exactStem", !imageOnly}});
            continue;
        }
        if (questionImages) continue;
        Json answer{{"type", type == "boolean" ? "judge" : type}, {"needsReview", false}};
        if (type == "single" || type == "multiple") {
            missReason = "options-mismatch";
            if (q["options"].size() != pageOptions.size()) continue;
            std::map<std::string, size_t> positions; bool compatible = true;
            for (size_t i = 0; i < pageOptions.size(); ++i) if (pageOptions[i].empty() || !positions.emplace(pageOptions[i], i).second) compatible = false;
            std::set<std::string> stored;
            for (const auto& option : q["options"]) {
                auto text = OptionText(option["text"].get<std::string>());
                if (!positions.count(text) || !stored.insert(text).second) compatible = false;
            }
            if (!compatible) continue;
            Json choices = Json::array();
            for (const auto& id : q["answer"]) for (const auto& option : q["options"]) if (option["id"] == id)
                choices.push_back(std::string(1, static_cast<char>('A' + positions.at(OptionText(option["text"].get<std::string>())))));
            std::sort(choices.begin(), choices.end()); answer["choices"] = choices;
        } else if (type == "boolean") answer["answers"] = Json::array({q["answer"].get<bool>() ? "正确" : "错误"});
        else if (type == "blank") {
            missReason = "blank-count-mismatch";
            if (!input.contains("blanks") || !input["blanks"].is_number_integer() || input["blanks"].get<int>() != static_cast<int>(q["answer"].size())) continue;
            answer["answers"] = Json::array(); for (const auto& variants : q["answer"]) answer["answers"].push_back(variants[0]);
        } else if (type == "text") answer["answers"] = Json::array({q["answer"]});
        else continue;
        if (sqlite3_column_int(s.value, 2) || (!accepted.is_null() && accepted != answer))
            return Json{{"ok", true}, {"matched", false}, {"reason", "ambiguous"}, {"review", review}};
        accepted = answer; bank = s.Text(1);
        matchedQuestion = Json{{"dbId", dbId}, {"bank", bank}, {"stem", q["stem"]}};
    }
    if (!imageCandidates.empty()) return Json{{"ok", true}, {"matched", false}, {"reason", "image-candidates"}, {"candidates", imageCandidates}, {"review", review}, {"revision", Scalar(db, "SELECT revision FROM bank_meta WHERE id=1")}};
    if (accepted.is_null()) return Json{{"ok", true}, {"matched", false}, {"reason", missReason}, {"review", review}};
    if (accepted.contains("answers")) {
        for (const auto& text : accepted["answers"]) {
            if (std::regex_search(text.get_ref<const std::string&>(), ImageReferencePattern()))
                return Json{{"ok", true}, {"matched", false}, {"reason", "answer-image"}, {"review", review}};
        }
    }
    return Json{{"ok", true}, {"matched", true}, {"answer", accepted}, {"bank", bank}, {"review", review},
        {"matchedQuestion", matchedQuestion}, {"revision", Scalar(db, "SELECT revision FROM bank_meta WHERE id=1")}};
}
}

void InitializeQuestionBank() {
    try {
        std::lock_guard<std::mutex> lock(bankMutex);
        EnsureDefault();
    } catch (...) {
        OutputDebugStringW(L"[CefHook] default question bank initialization failed\n");
    }
}

std::string HandleQuestionBankRequest(const std::string& body, const std::atomic<bool>& canceled) {
    try {
        if (body.empty() || body.size() > kMaxBody) throw Error("请求过大，每次请导入不超过 8 MiB 的 JSON 文件");
        // Bound parser nesting before constructing objects from untrusted files.
        auto input = Json::parse(body, [](int depth, Json::parse_event_t, Json&) { if (depth > 32) throw Error("JSON 嵌套过深"); return true; });
        if (!input.is_object()) throw Error("请求格式无效");
        auto action = Text(input, "action", 32, true);
        std::lock_guard<std::mutex> lock(bankMutex);
        if (canceled.load()) throw Error("操作已取消");
        EnsureDefault();
        if (action == "status") return Status().dump();
        if (!database) throw Error(restoreError.empty() ? "题库尚未就绪" : restoreError);
        if (action == "revision") return Json{{"ok", true}, {"revision", Scalar(database.get(), "SELECT revision FROM bank_meta WHERE id=1")}}.dump();
        if (action == "preview" || action == "import") return Import(input, canceled, action == "preview").dump();
        if (action == "resolve") return ResolveConflict(input, canceled).dump();
        // Keep data and its revision in one read snapshot, including other client processes.
        Exec(database.get(), "BEGIN");
        try {
            Json result;
            if (action == "search") result = Search(input, canceled);
            else if (action == "detail") result = Detail(input);
            else if (action == "images") result = Images(input);
            else if (action == "conflicts") result = Conflicts(input);
            else if (action == "conflictDetail") result = ConflictDetail(input);
            else if (action == "lookup") result = Lookup(input, canceled);
            else throw Error("不支持的题库操作");
            Exec(database.get(), "COMMIT"); return result.dump();
        } catch (...) { sqlite3_exec(database.get(), "ROLLBACK", nullptr, nullptr, nullptr); throw; }
    } catch (const std::exception& error) {
        return Json{{"ok", false}, {"error", error.what()}}.dump(-1, ' ', false, Json::error_handler_t::replace);
    } catch (...) { return "{\"ok\":false,\"error\":\"题库操作失败\"}"; }
}
