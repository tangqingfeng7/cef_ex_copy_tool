#include "../src/question_bank.cpp"
#include <iostream>
#define REQUIRE(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)

namespace {
std::atomic<bool> notCanceled{false};
Json Call(Json request) { return Json::parse(HandleQuestionBankRequest(request.dump(), notCanceled)); }
Json Question(std::string id, std::string stem = "测试题干") {
    return Json{{"id", id}, {"type", "single"}, {"stem", stem}, {"options", Json::array({Json{{"id", "A"}, {"text", "选项甲"}}, Json{{"id", "B"}, {"text", "选项乙"}}})}, {"answer", Json::array({"A"})}, {"tags", Json::array({"网络"})}};
}
Json Payload(std::string name, Json questions) { return Json{{"schemaVersion", 1}, {"name", name}, {"questions", questions}}; }
Json LookupInput(std::string stem) { return Json{{"action", "lookup"}, {"type", "single"}, {"stem", stem}, {"options", Json::array({"选项乙", "选项甲"})}}; }
void Reset() { database.reset(); OpenPath(L":memory:"); }
void TestPreviewAndPagination() {
    Reset(); Json questions = Json::array();
    for (int i = 0; i < 47; ++i) questions.push_back(Question(std::to_string(i), "题干" + std::to_string(i)));
    auto payload = Payload("网络课程", questions);
    auto preview = Call(Json{{"action", "preview"}, {"payload", payload}});
    REQUIRE(preview["ok"] && preview["valid"] && preview["inserted"] == 47);
    REQUIRE(Call(Json{{"action", "status"}})["count"] == 0);
    auto result = Call(Json{{"action", "import"}, {"payload", payload}, {"revision", preview["revision"]}});
    REQUIRE(result["ok"] && result["count"] == 47);
    REQUIRE(!Call(Json{{"action", "import"}, {"payload", payload}, {"revision", preview["revision"]}})["ok"]);
    auto repeated = Call(Json{{"action", "preview"}, {"payload", payload}}); REQUIRE(repeated["duplicates"] == 47);
    std::set<int64_t> ids; int64_t cursor = 0; int pages = 0;
    do {
        result = Call(Json{{"action", "search"}, {"bank", "网络课程"}, {"type", "single"}, {"tag", "网络"}, {"before", cursor}, {"pageSize", 20}});
        REQUIRE(result["ok"]); ++pages;
        for (const auto& q : result["questions"]) { REQUIRE(!q.contains("answer") && !q.contains("images")); REQUIRE(ids.insert(q["dbId"].get<int64_t>()).second); }
        cursor = result["nextCursor"];
    } while (result["more"] == true);
    REQUIRE(pages == 3 && ids.size() == 47);
    REQUIRE(Call(Json{{"action", "search"}, {"tag", "不存在"}})["questions"].empty());
    REQUIRE(Call(Json{{"action", "search"}, {"bank", "不存在"}})["questions"].empty());
    auto bad = payload; bad["questions"][2]["answer"] = "Z"; bad["questions"][7]["type"] = "bad";
    auto errors = Call(Json{{"action", "preview"}, {"payload", bad}});
    REQUIRE(errors["errorCount"] == 2 && errors["errors"][0]["index"] == 3 && errors["errors"][1]["index"] == 8);
    REQUIRE(!Call(Json{{"action", "import"}, {"payload", bad}})["ok"]);
    REQUIRE(Call(Json{{"action", "status"}})["count"] == 47);
    notCanceled = true; REQUIRE(!Call(Json{{"action", "import"}, {"payload", payload}})["ok"]); notCanceled = false;
    REQUIRE(Call(Json{{"action", "status"}})["count"] == 47);
    // Duplicates and conflicts inside the same file are classified using the same transaction as import.
    auto changed = Question("same"); changed["answer"] = Json::array({"B"});
    auto mixed = Payload("文件内重复", Json::array({Question("same"), Question("same"), changed}));
    auto counts = Call(Json{{"action", "preview"}, {"payload", mixed}});
    REQUIRE(counts["inserted"] == 1 && counts["duplicates"] == 1 && counts["importConflicts"] == 1);
    REQUIRE(Call(Json{{"action", "status"}})["count"] == 47);
}
void TestConflictAndMatching() {
    Reset(); auto q = Question("q1");
    REQUIRE(Call(Json{{"action", "import"}, {"payload", Payload("课程", Json::array({q}))}})["ok"]);
    auto found = Call(LookupInput("测试题干")); REQUIRE(found["matched"] && found["answer"]["choices"] == Json::array({"B"}));
    q["answer"] = Json::array({"B"});
    const auto conflictPayload = Payload("课程", Json::array({q}));
    const auto imported = Call(Json{{"action", "import"}, {"payload", conflictPayload}});
    REQUIRE(imported["importConflicts"] == 1);
    const auto repeatPreview = Call(Json{{"action", "preview"}, {"payload", conflictPayload}});
    REQUIRE(repeatPreview["importConflicts"] == 0 && repeatPreview["duplicates"] == 1);
    const auto repeated = Call(Json{{"action", "import"}, {"payload", conflictPayload}, {"revision", repeatPreview["revision"]}});
    REQUIRE(repeated["ok"] && repeated["duplicates"] == 1 && repeated["importConflicts"] == 0);
    REQUIRE(repeated["revision"] == imported["revision"]);
    auto miss = Call(LookupInput("测试题干")); REQUIRE(miss["reason"] == "ambiguous" && !miss["review"].empty());
    auto entries = Call(Json{{"action", "conflicts"}}); auto id = entries["conflicts"][0]["id"];
    auto detail = Call(Json{{"action", "conflictDetail"}, {"id", id}});
    REQUIRE(detail["current"]["answer"] != detail["incoming"]["answer"]);
    REQUIRE(!Call(Json{{"action", "resolve"}, {"id", id}, {"revision", -1}, {"decision", "incoming"}})["ok"]);
    REQUIRE(Call(Json{{"action", "status"}})["conflicts"] == 1);
    REQUIRE(Call(Json{{"action", "resolve"}, {"id", id}, {"revision", detail["revision"]}, {"decision", "incoming"}})["ok"]);
    found = Call(LookupInput("测试题干")); REQUIRE(found["matched"] && found["answer"]["choices"] == Json::array({"A"}));
    REQUIRE(Scalar(database.get(), "SELECT count(*) FROM conflict_history") == 1);
    REQUIRE(Call(Json{{"action", "status"}})["conflicts"] == 0);
    q["answer"] = Json::array({"A"});
    Call(Json{{"action", "import"}, {"payload", Payload("课程", Json::array({q}))}});
    entries = Call(Json{{"action", "conflicts"}}); id = entries["conflicts"][0]["id"];
    detail = Call(Json{{"action", "conflictDetail"}, {"id", id}});
    auto edited = detail["current"]; edited["stem"] = "修正后的题干";
    auto invalid = edited; invalid["answer"] = Json::array({"Z"});
    REQUIRE(!Call(Json{{"action", "resolve"}, {"id", id}, {"revision", detail["revision"]}, {"decision", "manual"}, {"question", invalid}})["ok"]);
    REQUIRE(Call(Json{{"action", "status"}})["conflicts"] == 1);
    REQUIRE(Call(Json{{"action", "resolve"}, {"id", id}, {"revision", detail["revision"]}, {"decision", "manual"}, {"question", edited}})["ok"]);
    REQUIRE(Call(LookupInput("修正后的题干"))["matched"]);
    REQUIRE(!Call(LookupInput("测试题干"))["matched"]);
    auto scoped = LookupInput("修正后的题干"); scoped["bank"] = "另一个课程"; REQUIRE(!Call(scoped)["matched"]);
    auto options = LookupInput("修正后的题干"); options["options"][0] = "不同选项";
    REQUIRE(Call(options)["reason"] == "options-mismatch");
    q = edited; q["answer"] = Json::array({"A"});
    Call(Json{{"action", "import"}, {"payload", Payload("课程", Json::array({q}))}});
    entries = Call(Json{{"action", "conflicts"}}); id = entries["conflicts"][0]["id"];
    detail = Call(Json{{"action", "conflictDetail"}, {"id", id}});
    REQUIRE(Call(Json{{"action", "resolve"}, {"id", id}, {"revision", detail["revision"]}, {"decision", "keep"}})["ok"]);
    REQUIRE(Call(LookupInput("修正后的题干"))["answer"]["choices"] == Json::array({"A"}));
    Statement plan(database.get(), "EXPLAIN QUERY PLAN SELECT id FROM questions WHERE type='single' AND normalized_stem IN ('题目','题目2')");
    bool indexed = false; while (plan.Step() == SQLITE_ROW) if (plan.Text(3).find("question_match_stem") != std::string::npos) indexed = true;
    REQUIRE(indexed);
}
void TestLazyImages() {
    Reset(); auto q = Question("image", "测试图片[图片:x]");
    q["images"] = Json::array({Json{{"id", "x"}, {"dataUrl", "data:image/png;base64,AAAA"}}});
    Call(Json{{"action", "import"}, {"payload", Payload("图片课", Json::array({q}))}});
    auto results = Call(Json{{"action", "search"}}); auto row = results["questions"][0];
    REQUIRE(row["imageCount"] == 1 && results.dump().find("base64") == std::string::npos);
    auto detail = Call(Json{{"action", "detail"}, {"id", row["dbId"]}});
    REQUIRE(detail["question"]["imageCount"] == 1 && !detail["question"].contains("images"));
    auto images = Call(Json{{"action", "images"}, {"id", row["dbId"]}, {"revision", detail["revision"]}}); REQUIRE(images["images"].size() == 1);
    REQUIRE(!Call(Json{{"action", "images"}, {"id", row["dbId"]}, {"revision", -1}})["ok"]);
    auto lookup = LookupInput("测试图片"); lookup["hasImages"] = true; lookup["alternateStem"] = "测试图片";
    auto candidates = Call(lookup); REQUIRE(candidates["candidates"].size() == 1 && candidates.dump().find("base64") == std::string::npos);
    REQUIRE(candidates["candidates"][0]["dbId"] == row["dbId"]);
    Json matchingOptions = Json::array();
    for (int i = 0; i < 20; ++i) {
        q["id"] = "image-" + std::to_string(i);
        matchingOptions.push_back(q);
    }
    REQUIRE(Call(Json{{"action", "import"}, {"payload", Payload("图片课", matchingOptions)}})["inserted"] == 20);
    lookup["stem"] = ""; lookup["alternateStem"] = "";
    const auto limited = Call(lookup);
    REQUIRE(limited["reason"] == "candidate-limit" && limited["review"].size() == 8);

    Reset();
    q["stem"] = "缺失干扰项";
    q["options"].push_back(Json{{"id", "C"}, {"text", "选项丙"}});
    q["options"].push_back(Json{{"id", "D"}, {"text", "干扰项[图片:x]"}});
    REQUIRE(Call(Json{{"action", "import"}, {"payload", Payload("图片课", Json::array({q}))}})["inserted"] == 1);
    lookup = LookupInput("缺失干扰项");
    lookup["hasImages"] = true; lookup["alternateStem"] = "缺失干扰项";
    lookup["options"].push_back("选项丙");
    REQUIRE(Call(lookup)["candidates"].size() == 1);
}
void TestConflictRevision() {
    Reset();
    auto question = Question("original");
    REQUIRE(Call(Json{{"action", "import"}, {"payload", Payload("课程", Json::array({question}))}})["inserted"] == 1);
    auto first = question, second = question, third = question;
    first["explanation"] = "另一版解析"; second["answer"] = Json::array({"B"}); third["explanation"] = "第三版解析";
    REQUIRE(Call(Json{{"action", "import"}, {"payload", Payload("课程", Json::array({first, second, third}))}})["importConflicts"] == 3);
    auto entries = Call(Json{{"action", "conflicts"}})["conflicts"];
    const auto firstId = entries[0]["id"], secondId = entries[1]["id"], thirdId = entries[2]["id"];
    const auto revision = Call(Json{{"action", "conflictDetail"}, {"id", firstId}})["revision"];
    const auto kept = Call(Json{{"action", "resolve"}, {"id", firstId}, {"revision", revision}, {"decision", "keep"}});
    REQUIRE(kept["ok"] && kept["questionChanged"] == false);
    const auto adopted = Call(Json{{"action", "resolve"}, {"id", secondId}, {"revision", revision}, {"decision", "incoming"}});
    REQUIRE(adopted["ok"] && adopted["questionChanged"] == true);
    const auto stale = Call(Json{{"action", "resolve"}, {"id", thirdId}, {"revision", revision}, {"decision", "incoming"}});
    REQUIRE(stale["ok"] == false && stale["code"] == "BANK_REVISION");
    const auto latest = Call(Json{{"action", "conflictDetail"}, {"id", thirdId}})["revision"];
    REQUIRE(Call(Json{{"action", "resolve"}, {"id", thirdId}, {"revision", latest}, {"decision", "keep"}})["ok"]);
    REQUIRE(Call(LookupInput("测试题干"))["answer"]["choices"] == Json::array({"A"}));
}
void TestLegacyImageIdentity() {
    Reset();
    auto old = Question("", "[图片:img7]");
    old["images"] = Json::array({Json{{"id", "img7"}, {"dataUrl", "data:image/png;base64,AAAA"}}});
    const auto validated = Validate(old);
    REQUIRE(Call(Json{{"action", "import"}, {"payload", Payload("课程", Json::array({old}))}})["inserted"] == 1);
    {
        Statement legacy(database.get(), "UPDATE questions SET identity=?,stem=?,record=?");
        legacy.Bind(1, Identity(validated)); legacy.Bind(2, old["stem"]); legacy.Bind(3, validated.dump()); legacy.Step();
        const auto id = sqlite3_last_insert_rowid(database.get());
        RefreshDerived(database.get(), id, id);
    }
    auto revised = old;
    revised["stem"] = "[图片:img9]"; revised["images"][0]["id"] = "img9";
    const auto duplicate = Call(Json{{"action", "import"}, {"format", "docx"}, {"payload", Payload("课程", Json::array({revised}))}});
    REQUIRE(duplicate["duplicates"] == 1 && duplicate["inserted"] == 0 && duplicate["importConflicts"] == 0);
    revised["answer"] = Json::array({"B"});
    auto other = revised;
    other["images"][0]["dataUrl"] = "data:image/png;base64,BBBB";
    const auto changes = Call(Json{{"action", "import"}, {"format", "docx"}, {"payload", Payload("课程", Json::array({other, revised}))}});
    REQUIRE(changes["inserted"] == 1 && changes["importConflicts"] == 1);
    const auto repeat = Call(Json{{"action", "import"}, {"format", "docx"}, {"payload", Payload("课程", Json::array({other, revised}))}});
    REQUIRE(repeat["duplicates"] == 2 && repeat["inserted"] == 0 && repeat["importConflicts"] == 0);
}
void TestStoredBlankAnswers() {
    Reset();
    const Json q{{"type", "blank"}, {"stem", "按编号填写条款"}, {"answer", Json::array({
        Json::array({"(1) 第一条", "(1) 其他写法"}), Json::array({"(2) 第二条"})
    })}};
    REQUIRE(Call(Json{{"action", "import"}, {"payload", Payload("填空课", Json::array({q}))}})["inserted"] == 1);
    auto result = Call(Json{{"action", "lookup"}, {"type", "blank"}, {"stem", "按编号填写条款"}, {"blanks", 2}});
    REQUIRE(result["matched"] && result["answer"]["answers"] == Json::array({"(1) 第一条", "(2) 第二条"}));
    const auto broken = Payload("图题", Json::array({Json{{"type", "text"}, {"stem", "比较[图片:img1]与[图片:diagram]"}, {"answer", "第二幅"},
        {"images", Json::array({Json{{"id", "diagram"}, {"dataUrl", "data:image/png;base64,AAAA"}}})}}}));
    const auto preview = Call(Json{{"action", "preview"}, {"payload", broken}});
    REQUIRE(preview["valid"] == false && preview["errors"][0]["error"].get<std::string>().find("[图片:img1]") != std::string::npos);
    REQUIRE(!Call(Json{{"action", "import"}, {"payload", broken}})["ok"]);
}
void TestMigration() {
    wchar_t temp[MAX_PATH]{}, filename[MAX_PATH]{}; GetTempPathW(MAX_PATH, temp); GetTempFileNameW(temp, L"cqb", 0, filename);
    database.reset(); sqlite3* old = nullptr; Check(sqlite3_open(Utf8(filename).c_str(), &old), old);
    try {
        Exec(old, "CREATE TABLE questions(id INTEGER PRIMARY KEY,bank TEXT NOT NULL,identity TEXT NOT NULL,type TEXT NOT NULL,stem TEXT NOT NULL,options TEXT NOT NULL,answer TEXT NOT NULL,explanation TEXT NOT NULL,tags TEXT NOT NULL,source TEXT NOT NULL,record TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(bank,identity));"
            "CREATE INDEX question_bank_name ON questions(bank);CREATE TABLE conflicts(id INTEGER PRIMARY KEY,question_id INTEGER NOT NULL REFERENCES questions(id),incoming TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(question_id,incoming));PRAGMA application_id=0x43585142;PRAGMA user_version=1;");
        auto q = Validate(Question("legacy", "旧库题干"));
        { Statement insert(old, "INSERT INTO questions(bank,identity,type,stem,options,answer,explanation,tags,source,record) VALUES('旧题库','id:legacy','single','旧库题干',?,?,'','[]','',?)"); insert.Bind(1, q["options"].dump()); insert.Bind(2, q["answer"].dump()); insert.Bind(3, q.dump()); insert.Step(); }
        sqlite3_close(old); old = nullptr;
        OpenPath(filename);
        REQUIRE(Scalar(database.get(), "PRAGMA user_version") == 2);
        REQUIRE(Call(LookupInput("旧库题干"))["matched"]);
        REQUIRE(Call(Json{{"action", "status"}})["count"] == 1);
        database.reset(); OpenPath(filename); REQUIRE(Call(LookupInput("旧库题干"))["matched"]);
        database.reset(); DeleteFileW(filename);
    } catch (...) { if (old) sqlite3_close(old); database.reset(); DeleteFileW(filename); throw; }
}
Json Judge(std::string stem, bool answer) { return Json{{"type", "boolean"}, {"stem", stem}, {"answer", answer}}; }
void TestJudgeMarkers() {
    Reset();
    const auto payload = Payload("判断", Json::array({Judge("地球是圆的。（ ）", true), Judge("水在零度结冰。", true), Judge("太阳从西边升起。（×）", false)}));
    REQUIRE(Call(Json{{"action", "import"}, {"payload", payload}})["inserted"] == 3);
    for (const char* stem : {"地球是圆的。", "地球是圆的。（ ）", "水在零度结冰。（ ）", "太阳从西边升起。"})
        REQUIRE(Call(Json{{"action", "lookup"}, {"type", "boolean"}, {"stem", stem}})["matched"]);
}
void TestNormalizationRefresh() {
    wchar_t temp[MAX_PATH]{}, filename[MAX_PATH]{}; GetTempPathW(MAX_PATH, temp); GetTempFileNameW(temp, L"cqb", 0, filename);
    const auto lookup = [] { return Call(Json{{"action", "lookup"}, {"type", "boolean"}, {"stem", "地球是圆的。"}}); };
    try {
        database.reset(); OpenPath(filename);
        REQUIRE(Call(Json{{"action", "import"}, {"payload", Payload("判断", Json::array({Judge("地球是圆的。（ ）", true)}))}})["inserted"] == 1);
        for (const char* stale : {"UPDATE bank_meta SET normalization=0", "ALTER TABLE bank_meta DROP COLUMN normalization"}) {
            Exec(database.get(), "UPDATE questions SET normalized_stem='stale'"); Exec(database.get(), stale);
            REQUIRE(!lookup()["matched"]);
            database.reset(); OpenPath(filename);
            REQUIRE(Scalar(database.get(), "SELECT normalization FROM bank_meta") == kNormalizationVersion && lookup()["matched"]);
        }
        database.reset(); DeleteFileW(filename);
    } catch (...) { database.reset(); DeleteFileW(filename); throw; }
}
void TestResolveDuplicateIdentity() {
    Reset();
    const auto text = [](std::string stem, std::string answer) { return Json{{"type", "text"}, {"stem", stem}, {"answer", answer}}; };
    Call(Json{{"action", "import"}, {"payload", Payload("课程", Json::array({text("题甲", "一"), text("题乙", "二")}))}});
    Call(Json{{"action", "import"}, {"payload", Payload("课程", Json::array({text("题甲", "新答案")}))}});
    const auto id = Call(Json{{"action", "conflicts"}})["conflicts"][0]["id"];
    const auto detail = Call(Json{{"action", "conflictDetail"}, {"id", id}});
    auto edited = detail["current"]; edited["stem"] = "题乙";
    const auto result = Call(Json{{"action", "resolve"}, {"id", id}, {"revision", detail["revision"]}, {"decision", "manual"}, {"question", edited}});
    REQUIRE(!result["ok"] && result["error"].get<std::string>().find("另一道题重复") != std::string::npos);
    REQUIRE(Call(Json{{"action", "status"}})["conflicts"] == 1);
}
void TestImportByteBudget() {
    Reset(); Json questions = Json::array();
    for (int i = 0; i < 11; ++i)
        questions.push_back(Json{{"type", "text"}, {"stem", "共用题图[图片:img1]" + std::to_string(i)}, {"answer", "说明"}, {"images", Json::array({Json{{"id", "img1"}}})}});
    auto payload = Payload("共用图片", questions);
    payload["sharedImages"] = Json{{"img1", "data:image/png;base64," + std::string(6 * 1024 * 1024 - 64, 'A')}};
    const auto result = Call(Json{{"action", "import"}, {"format", "docx"}, {"payload", payload}});
    REQUIRE(!result["ok"] && result["error"].get<std::string>().find("64 MiB") != std::string::npos);
    REQUIRE(Call(Json{{"action", "status"}})["count"] == 0);
}
}
int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--serve") {
        try {
            Reset(); std::string line;
            while (std::getline(std::cin, line)) std::cout << HandleQuestionBankRequest(line, notCanceled) << std::endl;
            return 0;
        } catch (const std::exception& error) { std::cerr << error.what(); return 1; }
    }
    try { TestPreviewAndPagination(); TestConflictAndMatching(); TestLazyImages(); TestConflictRevision(); TestLegacyImageIdentity(); TestStoredBlankAnswers(); TestMigration();
        TestJudgeMarkers(); TestNormalizationRefresh(); TestResolveDuplicateIdentity(); TestImportByteBudget(); std::cout << "question bank management tests passed\n"; return 0; }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
