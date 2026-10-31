#include "question_bank.h"
#include "ai_config.h"
#include "vendor/sqlite/sqlite3.h"
#include "vendor/nlohmann/json.hpp"
#include <shlobj.h>
#include <algorithm>
#include <memory>
#include <mutex>
#include <set>
#include <regex>
#include <stdexcept>
#include <vector>

namespace {
using Json = nlohmann::json;
constexpr int kApplicationId = 0x43585142;
constexpr size_t kMaxBody = 10 * 1024 * 1024;
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
std::wstring Directory() {
    wchar_t local[MAX_PATH]{};
    if (FAILED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, SHGFP_TYPE_CURRENT, local))) throw Error("无法读取本机数据目录");
    std::wstring path = std::wstring(local) + L"\\cef_ex_copy_tool";
    if (!CreateDirectoryW(path.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) throw Error("无法创建题库目录");
    return path;
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
        if (ch == L' ' || ch == L'\t' || ch == L'\n' || ch == L'\r' || ch == 0xa0 || ch == 0x3000) { space = !normalized.empty(); continue; }
        if (space) normalized += L' ';
        space = false; normalized += ch;
    }
    return Utf8(normalized);
}
std::string StemText(const std::string& text) {
    auto normalized = MatchText(text);
    if (normalized.empty()) return {};
    std::wstring wide;
    if (!ScriptUtf8ToWide(normalized, wide)) throw Error("题目编码无效");
    static const std::wregex labels(LR"(^(\s*【(单选题|多选题|判断题|填空题|简答题|问答题|论述题|编程题)】\s*)+)");
    wide = std::regex_replace(wide, labels, L"");
    static const std::wregex emptyBlank(LR"(\(\s+\))");
    return MatchText(Utf8(std::regex_replace(wide, emptyBlank, L"()")));
}
std::string JudgeStem(const std::string& text) {
    auto normalized = StemText(text);
    if (normalized.empty()) return {};
    std::wstring wide;
    if (!ScriptUtf8ToWide(normalized, wide)) throw Error("题目编码无效");
    // A marked answer at the end of an exported proposition is not part of the proposition.
    static const std::wregex marked(LR"(\s*[（(]\s*(正确|错误|对|错|true|false|T|F|√|×)?\s*[）)]\s*[。.]?\s*$)", std::regex_constants::icase);
    return MatchText(Utf8(std::regex_replace(wide, marked, L"")));
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
void OpenDefault() {
    const auto path = DefaultPath();
    const bool create = true;
    sqlite3* raw = nullptr;
    const auto filename = Utf8(path);
    int rc = sqlite3_open_v2(filename.c_str(), &raw, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | (create ? SQLITE_OPEN_CREATE : 0), nullptr);
    std::unique_ptr<sqlite3, decltype(&sqlite3_close)> next(raw, sqlite3_close);
    Check(rc, raw);
    sqlite3_busy_timeout(raw, 3000);
    sqlite3_limit(raw, SQLITE_LIMIT_LENGTH, 16 * 1024 * 1024);
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
    if (app != kApplicationId || version != 1) throw Error("目录中的 question-bank.db 格式不兼容，请保留原文件并转换成 JSON 后导入");
    { Statement schema(raw, "SELECT bank,identity,type,stem,options,answer,explanation,tags,source,record,created_at FROM questions LIMIT 0"); schema.Step(); }
    { Statement schema(raw, "SELECT question_id,incoming FROM conflicts LIMIT 0"); schema.Step(); }
    // Never run triggers supplied by an imported database during later inserts.
    if (Scalar(raw, "SELECT count(*) FROM sqlite_master WHERE type IN ('trigger','view')") != 0) throw Error("题库包含不支持的触发器或视图");
    database.swap(next); connectedPath = path; restoreError.clear();
}
void MigrateDefault() {
    const auto target = DefaultPath(), legacy = Directory() + L"\\question-bank.db";
    if (_wcsicmp(target.c_str(), legacy.c_str()) == 0 || GetFileAttributesW(target.c_str()) != INVALID_FILE_ATTRIBUTES ||
        GetFileAttributesW(legacy.c_str()) == INVALID_FILE_ATTRIBUTES) return;
    sqlite3* raw = nullptr;
    int rc = sqlite3_open_v2(Utf8(legacy).c_str(), &raw, SQLITE_OPEN_READONLY, nullptr);
    std::unique_ptr<sqlite3, decltype(&sqlite3_close)> source(raw, sqlite3_close);
    Check(rc, raw); sqlite3_busy_timeout(raw, 3000);
    if (Scalar(raw, "PRAGMA application_id") != kApplicationId || Scalar(raw, "PRAGMA user_version") != 1)
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
    Json result{{"ok", true}, {"connected", !!database}, {"path", Utf8(connectedPath)}, {"defaultPath", Utf8(DefaultPath())}, {"count", 0}, {"conflicts", 0}, {"schemaVersion", 1}};
    if (database) {
        result["count"] = Scalar(database.get(), "SELECT count(*) FROM questions");
        result["conflicts"] = Scalar(database.get(), "SELECT count(*) FROM conflicts");
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
Json Validate(const Json& q) {
    if (!q.is_object()) throw Error("题目必须是 JSON 对象");
    Json result;
    result["id"] = Text(q, "id", 256);
    result["type"] = Text(q, "type", 20, true);
    result["stem"] = Text(q, "stem", 64000, true);
    result["explanation"] = Text(q, "explanation", 128000);
    result["source"] = Text(q, "source", 2048);
    result["options"] = q.value("options", Json::array());
    result["tags"] = q.value("tags", Json::array());
    if (q.contains("images") && !q["images"].empty()) {
        if (!q["images"].is_array() || q["images"].size() > 32) throw Error("每题图片最多 32 张");
        std::set<std::string> imageIds; size_t bytes = 0;
        result["images"] = Json::array();
        for (const auto& image : q["images"]) {
            if (!image.is_object()) throw Error("题图格式无效");
            auto id = Text(image, "id", 128, true), data = Text(image, "dataUrl", 6 * 1024 * 1024, true);
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
            for (const auto& variant : blank) if (!variant.is_string() || variant.get<std::string>().empty() || variant.get<std::string>().size() > 16000) throw Error("填空答案必须是非空文字");
        }
        // Older JSON exports retained the page's sequential blank labels.
        bool numbered = answer.size() > 1;
        for (size_t i = 0; numbered && i < answer.size(); ++i) {
            const auto prefix = "(" + std::to_string(i + 1) + ")";
            const auto value = answer[i][0].get<std::string>();
            numbered = value.compare(0, prefix.size(), prefix) == 0 && value.size() > prefix.size();
        }
        if (numbered) for (size_t i = 0; i < answer.size(); ++i) {
            auto value = answer[i][0].get<std::string>().substr(std::to_string(i + 1).size() + 2);
            const auto first = value.find_first_not_of(" \t\r\n");
            if (first != std::string::npos) answer[i][0] = value.substr(first);
        }
    } else if (type == "text") {
        if (!answer.is_string() || answer.get<std::string>().empty() || answer.get<std::string>().size() > 128000) throw Error("简答题答案必须是非空文字");
    } else throw Error("不支持的题型：使用 single、multiple、boolean、blank 或 text");
    result["answer"] = answer;
    return result;
}
Json Import(const Json& payload, const std::atomic<bool>& canceled) {
    if (!database) throw Error("默认题库尚未就绪，请检查 DLL 目录写入权限后重新打开题库页");
    if (!payload.is_object() || payload.value("schemaVersion", 0) != 1) throw Error("题库 JSON 的 schemaVersion 必须为 1");
    auto name = Text(payload, "name", 256, true);
    if (!payload.contains("questions") || !payload["questions"].is_array() || payload["questions"].empty() || payload["questions"].size() > 10000) throw Error("每次导入应包含 1 至 10000 道题");
    int inserted = 0, duplicates = 0, conflicts = 0, index = 0;
    auto* db = database.get();
    Progress progress(db, canceled);
    Exec(db, "BEGIN IMMEDIATE");
    try {
        Statement find(db, "SELECT id,record FROM questions WHERE bank=? AND identity=?");
        Statement insert(db, "INSERT INTO questions(bank,identity,type,stem,options,answer,explanation,tags,source,record) VALUES(?,?,?,?,?,?,?,?,?,?)");
        Statement conflict(db, "INSERT OR IGNORE INTO conflicts(question_id,incoming) VALUES(?,?)");
        for (const auto& item : payload["questions"]) {
            ++index;
            if (canceled.load()) throw Error("导入已取消，本次数据未写入");
            Json q = Validate(item);
            std::string identity = q["id"].get<std::string>();
            identity = identity.empty() ? "content:" + Json::array({q["type"], q["stem"], q["options"]}).dump() : "id:" + identity;
            const auto record = q.dump();
            find.Bind(1, name); find.Bind(2, identity);
            if (find.Step() == SQLITE_ROW) {
                if (find.Text(1) == record) ++duplicates;
                else {
                    Check(sqlite3_bind_int64(conflict.value, 1, sqlite3_column_int64(find.value, 0)), db);
                    conflict.Bind(2, record); conflict.Step(); conflict.Reset(); ++conflicts;
                }
            } else {
                insert.Bind(1, name); insert.Bind(2, identity); insert.Bind(3, q["type"].get<std::string>()); insert.Bind(4, q["stem"].get<std::string>());
                insert.Bind(5, q["options"].dump()); insert.Bind(6, q["answer"].dump()); insert.Bind(7, q["explanation"].get<std::string>());
                insert.Bind(8, q["tags"].dump()); insert.Bind(9, q["source"].get<std::string>()); insert.Bind(10, record); insert.Step(); insert.Reset(); ++inserted;
            }
            find.Reset();
        }
        if (canceled.load()) throw Error("导入已取消，本次数据未写入");
        Exec(db, "COMMIT");
    } catch (const std::exception& error) {
        sqlite3_progress_handler(db, 0, nullptr, nullptr);
        sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
        throw Error("第 " + std::to_string(index) + " 道题：" + error.what() + "；本次导入已回滚");
    }
    auto result = Status(); result["inserted"] = inserted; result["duplicates"] = duplicates; result["importConflicts"] = conflicts;
    return result;
}
Json Search(const Json& input, const std::atomic<bool>& canceled) {
    if (!database) throw Error("默认题库尚未就绪，请重新打开题库页查看原因");
    auto query = Text(input, "query", 512);
    auto* db = database.get();
    Progress progress(db, canceled);
    Statement s(db, "SELECT bank,record FROM questions WHERE instr(lower(stem),lower(?))>0 ORDER BY id DESC LIMIT 51");
    s.Bind(1, query); Json rows = Json::array(); size_t bytes = 0; bool more = false;
    while (s.Step() == SQLITE_ROW) {
        if (canceled.load()) throw Error("查询已取消");
        auto raw = s.Text(1); bytes += raw.size();
        if (rows.size() >= 50 || bytes > 4u * 1024u * 1024u) { more = true; break; }
        auto record = Validate(Json::parse(raw)); record["bank"] = s.Text(0); rows.push_back(record);
    }
    return Json{{"ok", true}, {"questions", rows}, {"more", more}};
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
        pageOptions.push_back(MatchText(option.get<std::string>()));
    }
    auto* db = database.get(); Progress progress(db, canceled);
    Statement s(db, "SELECT q.record,q.bank,EXISTS(SELECT 1 FROM conflicts c WHERE c.question_id=q.id) FROM questions q WHERE q.type=? AND (?=1 OR (CASE WHEN q.type='boolean' THEN cef_judge_stem(q.stem) ELSE cef_stem(q.stem) END)=? OR (CASE WHEN q.type='boolean' THEN cef_judge_stem(q.stem) ELSE cef_stem(q.stem) END)=?) LIMIT 101");
    s.Bind(1, type); s.BindInt(2, input.value("hasImages", false) && alternate.empty() ? 1 : 0); s.Bind(3, stem); s.Bind(4, alternate.empty() ? stem : alternate);
    Json accepted, imageCandidates = Json::array(); std::string bank; int candidates = 0; size_t candidateBytes = 0;
    while (s.Step() == SQLITE_ROW) {
        if (canceled.load()) throw Error("题库查询已取消");
        if (++candidates > 100) return Json{{"ok", true}, {"matched", false}, {"reason", "ambiguous"}};
        auto q = Validate(Json::parse(s.Text(0)));
        if (hasImages) {
            if (!q.contains("images") || q["images"].empty()) continue;
            candidateBytes += q.dump().size();
            if (imageCandidates.size() >= 20 || candidateBytes > 8u * 1024u * 1024u)
                return Json{{"ok", true}, {"matched", false}, {"reason", "ambiguous"}};
            imageCandidates.push_back(Json{{"question", q}, {"bank", s.Text(1)}, {"conflict", sqlite3_column_int(s.value, 2) != 0}});
            continue;
        }
        if (q.contains("images") && !q["images"].empty()) continue;
        Json answer{{"type", type == "boolean" ? "judge" : type}, {"needsReview", false}};
        if (type == "single" || type == "multiple") {
            if (q["options"].size() != pageOptions.size()) continue;
            std::map<std::string, size_t> positions; bool compatible = true;
            for (size_t i = 0; i < pageOptions.size(); ++i) if (pageOptions[i].empty() || !positions.emplace(pageOptions[i], i).second) compatible = false;
            std::set<std::string> stored;
            for (const auto& option : q["options"]) {
                auto text = MatchText(option["text"].get<std::string>());
                if (!positions.count(text) || !stored.insert(text).second) compatible = false;
            }
            if (!compatible) continue;
            Json choices = Json::array();
            for (const auto& id : q["answer"]) for (const auto& option : q["options"]) if (option["id"] == id)
                choices.push_back(std::string(1, static_cast<char>('A' + positions.at(MatchText(option["text"].get<std::string>())))));
            std::sort(choices.begin(), choices.end()); answer["choices"] = choices;
        } else if (type == "boolean") answer["answers"] = Json::array({q["answer"].get<bool>() ? "正确" : "错误"});
        else if (type == "blank") {
            if (!input.contains("blanks") || !input["blanks"].is_number_integer() || input["blanks"].get<int>() != static_cast<int>(q["answer"].size())) continue;
            answer["answers"] = Json::array(); for (const auto& variants : q["answer"]) answer["answers"].push_back(variants[0]);
        } else if (type == "text") answer["answers"] = Json::array({q["answer"]});
        else continue;
        if (sqlite3_column_int(s.value, 2) || (!accepted.is_null() && accepted != answer))
            return Json{{"ok", true}, {"matched", false}, {"reason", "ambiguous"}};
        accepted = answer; bank = s.Text(1);
    }
    if (hasImages) return Json{{"ok", true}, {"matched", false}, {"reason", "image-candidates"}, {"candidates", imageCandidates}};
    if (accepted.is_null()) return Json{{"ok", true}, {"matched", false}, {"reason", "not-found"}};
    return Json{{"ok", true}, {"matched", true}, {"answer", accepted}, {"bank", bank}};
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
        if (action == "import") return Import(input.at("payload"), canceled).dump();
        if (action == "search") return Search(input, canceled).dump();
        if (action == "lookup") return Lookup(input, canceled).dump();
        throw Error("不支持的题库操作");
    } catch (const std::exception& error) {
        return Json{{"ok", false}, {"error", error.what()}}.dump(-1, ' ', false, Json::error_handler_t::replace);
    } catch (...) { return "{\"ok\":false,\"error\":\"题库操作失败\"}"; }
}
