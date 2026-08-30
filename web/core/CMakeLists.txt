cmake_minimum_required(VERSION 3.28)

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    project(rpcs3_web_core LANGUAGES CXX)
endif()

add_library(rpcs3_web_guest_memory STATIC
    guest_memory.cpp
    ppu_elf_loader.cpp
    ppu_interpreter.cpp
    ppu_smoke.cpp
)
target_include_directories(rpcs3_web_guest_memory PUBLIC include)
target_compile_features(rpcs3_web_guest_memory PUBLIC cxx_std_23)

if(EMSCRIPTEN)
    add_executable(rpcs3_web_probe probe_main.cpp)
    target_link_libraries(rpcs3_web_probe PRIVATE rpcs3_web_guest_memory)
    set_target_properties(rpcs3_web_probe PROPERTIES
        OUTPUT_NAME "rpcs3-web-probe-v4"
        SUFFIX ".mjs"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/web/public/core"
    )
    target_compile_options(rpcs3_web_probe PRIVATE -pthread)
    target_link_options(rpcs3_web_probe PRIVATE
        -pthread
        "-sMODULARIZE=1"
        "-sEXPORT_ES6=1"
        "-sEXPORT_NAME=createRpcs3WebProbe"
        "-sENVIRONMENT=web,worker"
        "-sALLOW_MEMORY_GROWTH=1"
        "-sINITIAL_MEMORY=67108864"
        "-sMAXIMUM_MEMORY=536870912"
        "-sPTHREAD_POOL_SIZE=2"
        "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']"
        "-sEXPORTED_FUNCTIONS=['_malloc','_free','_rpcs3_web_probe_abi_version','_rpcs3_web_probe_memory','_rpcs3_web_probe_mapped_pages','_rpcs3_web_probe_resident_pages','_rpcs3_web_probe_ppu','_rpcs3_web_probe_ppu_steps','_rpcs3_web_probe_ppu_result','_rpcs3_web_probe_ppu_loaded','_rpcs3_web_probe_ppu_supported_opcodes','_rpcs3_web_probe_elf','_rpcs3_web_probe_elf_loaded','_rpcs3_web_probe_elf_segments','_rpcs3_web_probe_elf_entry','_rpcs3_web_probe_elf_steps','_rpcs3_web_probe_elf_stop_reason','_rpcs3_web_probe_elf_pc','_rpcs3_web_probe_elf_last_opcode','_rpcs3_web_probe_elf_target']"
    )
else()
    include(CTest)
    add_executable(rpcs3_web_guest_memory_tests tests/guest_memory_test.cpp)
    target_link_libraries(rpcs3_web_guest_memory_tests PRIVATE rpcs3_web_guest_memory)
    target_compile_definitions(rpcs3_web_guest_memory_tests PRIVATE RPCS3_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../..")
    add_test(NAME rpcs3_web_guest_memory_tests COMMAND rpcs3_web_guest_memory_tests)
endif()
