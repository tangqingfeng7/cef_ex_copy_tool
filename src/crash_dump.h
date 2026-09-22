#pragma once
#include <string>

// Installs a process-local unhandled-exception filter and chains the previous
// filter after writing one local minidump. No dump is uploaded automatically.
bool InstallCrashDumpHandler();
std::wstring CrashDumpDiagnosticsJson();
