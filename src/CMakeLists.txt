find_path(DETOURS_INCLUDE_DIRS "detours/detours.h")
find_library(DETOURS_LIBRARY detours REQUIRED)

file(GLOB SOURCES "*.cpp" "*.c")
add_library(CefHook SHARED ${SOURCES})
set_target_properties(CefHook PROPERTIES
    LINKER_LANGUAGE C
    OUTPUT_NAME "winmm"
    PREFIX ""
)
target_include_directories(CefHook PRIVATE ${DETOURS_INCLUDE_DIRS})
target_link_libraries(CefHook PRIVATE ${DETOURS_LIBRARY})

# Embed the tested JS verbatim so clipboard repair needs only winmm.dll.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${CMAKE_SOURCE_DIR}/scripts/clipboard_fix.js"
    "${CMAKE_SOURCE_DIR}/scripts/userscript_boot.js")
file(READ "${CMAKE_SOURCE_DIR}/scripts/clipboard_fix.js" CLIPBOARD_REPAIR_JS)
# MSVC limits each wide raw literal; concatenate lines without changing JS bytes.
string(REPLACE "\n" "\n)CEFPASTE\"\nLR\"CEFPASTE(" CLIPBOARD_REPAIR_JS "${CLIPBOARD_REPAIR_JS}")
file(READ "${CMAKE_SOURCE_DIR}/scripts/userscript_boot.js" USERSCRIPT_BOOT_JS)
configure_file(clipboard_repair.h.in generated/clipboard_repair.h @ONLY)
target_include_directories(CefHook PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
if(MSVC)
    target_compile_options(CefHook PRIVATE /utf-8 /Zi)
    target_link_options(CefHook PRIVATE /DEBUG /INCREMENTAL:NO)
endif()
if(BUILD_TESTING)
    add_executable(native_callbacks "${CMAKE_SOURCE_DIR}/tests/native_callbacks.cpp")
    target_include_directories(native_callbacks PRIVATE ${DETOURS_INCLUDE_DIRS} "${CMAKE_CURRENT_BINARY_DIR}/generated")
    target_link_libraries(native_callbacks PRIVATE ${DETOURS_LIBRARY} Shlwapi)
    target_compile_options(native_callbacks PRIVATE /utf-8)
    add_test(NAME native_callbacks COMMAND native_callbacks)
endif()
