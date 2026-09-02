# Define GNU standard installation directories
include(GNUInstallDirs)

# Generate git-version.h at build time.
include(${CMAKE_CURRENT_SOURCE_DIR}/git-version.cmake)

# Check for a sufficient compiler and set build options
include(ConfigureCompiler)
include(CheckFunctionExists)

set(CMAKE_CXX_STANDARD 23)

if(UNIX AND NOT APPLE AND NOT ANDROID AND NOT RPCS3_WEB)
    add_compile_definitions(DATADIR="${CMAKE_INSTALL_FULL_DATADIR}/rpcs3")
    # Optionally enable X11 for window management
    find_package(X11)
    if(X11_FOUND)
        add_compile_definitions(HAVE_X11)
    endif()
    find_package(Wayland)
    if(WAYLAND_FOUND)
        add_compile_definitions(HAVE_WAYLAND)
    endif()
endif()

if (NOT ANDROID AND NOT RPCS3_WEB)
    # Qt
    # finds Qt libraries and setups custom commands for MOC and UIC
    # Must be done here because generated MOC and UIC targets cant
    # be found otherwise
    include(${CMAKE_SOURCE_DIR}/3rdparty/qt6.cmake)
endif()

# subdirectories
add_subdirectory(Emu)

if (NOT ANDROID AND NOT RPCS3_WEB)
    add_subdirectory(rpcs3qt)
endif()

gen_git_version(${CMAKE_CURRENT_SOURCE_DIR})

if(RPCS3_WEB)
	set(RPCS3_WEB_INITIAL_MEMORY "536870912" CACHE STRING
		"Initial Wasm linear-memory size for the full browser runtime")
	option(RPCS3_WEB_ALLOW_MEMORY_GROWTH
		"Allow the full browser runtime to grow its shared Wasm memory" ON)
	# The shipped runtime is what Mobile Safari has to download and compile
	# without a code cache, so it carries no name section or assertion code.
	# The profile variant keeps function names for CPU profiles and traces.
	option(RPCS3_WEB_PROFILE
		"Keep function names, assertions, and profiling symbols in the browser runtime" OFF)
	add_executable(rpcs3_web_runtime
		${CMAKE_SOURCE_DIR}/web/host/rpcs3_web_main.cpp)
	target_link_libraries(rpcs3_web_runtime PRIVATE
		rpcs3_emu
		3rdparty::fusion
		3rdparty::zlib)
	set_target_properties(rpcs3_web_runtime PROPERTIES
		OUTPUT_NAME "rpcs3-web"
		SUFFIX ".mjs")
	target_link_options(rpcs3_web_runtime PRIVATE
		-pthread
		"-Wl,--error-limit=0"
		"-sMODULARIZE=1"
		"-sEXPORT_ES6=1"
		"-sEXPORT_NAME=createRPCS3"
		"-sENVIRONMENT=web,worker"
		"-sWASMFS=1"
		"-sMAXIMUM_MEMORY=2147483648"
		"-sINITIAL_MEMORY=${RPCS3_WEB_INITIAL_MEMORY}"
		"-sSTACK_SIZE=8388608"
		# Measured stack high-water marks on the homebrew fixtures are under
		# 16 KiB per RPCS3 thread; 1 MiB keeps a wide margin without the 8 MiB
		# per thread the implicit default committed. The pool is sized by the
		# host (Module.pthreadPoolSize) so Mobile Safari can start fewer
		# workers; Emscripten grows it on demand if RPCS3 needs more.
		"-sDEFAULT_PTHREAD_STACK_SIZE=1048576"
		"-sPTHREAD_POOL_SIZE=(Module['pthreadPoolSize']||12)"
		"-sALLOW_TABLE_GROWTH=1"
		"-Wl,--export=__stack_pointer"
		"SHELL:--pre-js ${CMAKE_SOURCE_DIR}/web/host/rpcs3_web_pre.js"
		"-sNO_EXIT_RUNTIME=1"
		"-sFORCE_FILESYSTEM=1"
		"-sEXPORTED_RUNTIME_METHODS=['FS','ccall','HEAPU8','PThread']"
		"-sEXPORTED_FUNCTIONS=['_main','_malloc','_free']"
		"-sWASM_BIGINT=1")
	set_property(TARGET rpcs3_web_runtime APPEND PROPERTY LINK_DEPENDS ${CMAKE_SOURCE_DIR}/web/host/rpcs3_web_pre.js)
	# ASSERTIONS stays on in both variants: it only adds a stack cookie and JS
	# glue checks, and it is what keeps Emscripten from minifying the wasm
	# import/export names that the PPU/SPU AOT side modules link against
	# (env.memory, rpcs3_web_* exports). The profile variant additionally keeps
	# the function name section for CPU profiles and traces.
	target_link_options(rpcs3_web_runtime PRIVATE "-sASSERTIONS=1")
	if(RPCS3_WEB_PROFILE)
		target_link_options(rpcs3_web_runtime PRIVATE
			"-g1"
			"--profiling-funcs")
	endif()
	if(RPCS3_WEB_ALLOW_MEMORY_GROWTH)
		target_link_options(rpcs3_web_runtime PRIVATE "-sALLOW_MEMORY_GROWTH=1")
	else()
		target_link_options(rpcs3_web_runtime PRIVATE "-sALLOW_MEMORY_GROWTH=0")
	endif()

	# Compile the original low-dependency RPCS3 GoogleTest sources to Wasm.  The
	# project already carries this GoogleTest copy through yaml-cpp, which keeps
	# the browser lane offline and pinned to the same dependency as native builds.
	set(RPCS3_WEB_GTEST_ROOT
		"${CMAKE_SOURCE_DIR}/3rdparty/yaml-cpp/yaml-cpp/test/googletest-1.13.0/googletest")
	add_library(rpcs3_web_gtest STATIC
		"${RPCS3_WEB_GTEST_ROOT}/src/gtest-all.cc")
	target_include_directories(rpcs3_web_gtest
		PUBLIC "${RPCS3_WEB_GTEST_ROOT}/include"
		PRIVATE "${RPCS3_WEB_GTEST_ROOT}")

	add_executable(rpcs3_web_unit_tests
		${CMAKE_SOURCE_DIR}/web/host/rpcs3_web_unit_main.cpp
		${CMAKE_SOURCE_DIR}/Utilities/StrFmt.cpp
		Emu/RSX/Program/Assembler/FPASM.cpp
		Emu/RSX/Program/Assembler/FPOpcodes.cpp
		Emu/RSX/Program/Assembler/FPToCFG.cpp
		Emu/RSX/Program/Assembler/Passes/FP/RegisterAnnotationPass.cpp
		Emu/RSX/Program/Assembler/Passes/FP/RegisterDependencyPass.cpp
		tests/test_bit_set.cpp
		tests/test_address_range.cpp
		tests/test_fmt.cpp
		tests/test_pair.cpp
		tests/test_rsx_cfg.cpp
		tests/test_rsx_fp_asm.cpp
		tests/test_tuple.cpp
		tests/test_simple_array.cpp
		tests/test_types_util.cpp)
	target_link_libraries(rpcs3_web_unit_tests PRIVATE rpcs3_web_gtest)
	target_include_directories(rpcs3_web_unit_tests PRIVATE
		${CMAKE_SOURCE_DIR}
		${CMAKE_CURRENT_SOURCE_DIR})
	# GoogleTest intentionally accepts differently signed operands. RPCS3's
	# global -Werror policy would otherwise reject its comparison helper before
	# the tests can execute in the browser.
	target_compile_options(rpcs3_web_unit_tests PRIVATE
		-msimd128
		-msse4.1
		-Wno-error=sign-compare)
	set_target_properties(rpcs3_web_unit_tests PROPERTIES
		OUTPUT_NAME "rpcs3-web-units"
		SUFFIX ".mjs")
	target_link_options(rpcs3_web_unit_tests PRIVATE
		"-sMODULARIZE=1"
		"-sEXPORT_ES6=1"
		"-sEXPORT_NAME=createRPCS3Units"
		"-sENVIRONMENT=web,worker"
		"-sALLOW_MEMORY_GROWTH=1"
		"-sINITIAL_MEMORY=33554432"
		"-sMAXIMUM_MEMORY=536870912"
		"-sNO_EXIT_RUNTIME=1"
		"-sASSERTIONS=1"
		"-sWASM_BIGINT=1")
    return()
endif()

if (NOT ANDROID)
    # Build rpcs3_lib
    add_library(rpcs3_lib STATIC)

    if(WIN32)
        target_compile_definitions(rpcs3_lib PRIVATE UNICODE _UNICODE)
    endif()

    set_target_properties(rpcs3_lib
        PROPERTIES
            AUTOMOC ON
            AUTOUIC ON)

    target_link_libraries(rpcs3_lib
        PUBLIC
            3rdparty::stblib
            3rdparty::libevdev
            rpcs3_emu
        PRIVATE
            rpcs3_ui
            3rdparty::discordRPC
            3rdparty::qt6
            3rdparty::hidapi
            3rdparty::libusb
            3rdparty::wolfssl
            3rdparty::libcurl
            3rdparty::zlib
            3rdparty::opencv
            3rdparty::fusion)

    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        #on some Linux distros shm_unlink and similar functions are in librt only
        target_link_libraries(rpcs3_lib PRIVATE rt)
    elseif(NOT WIN32 AND NOT CMAKE_CXX_FLAGS MATCHES "LIBICONV_PLUG")
        #it seems like glibc includes the iconv functions we use but other libc
        #implementations like the one on OSX don't seem implement them
        target_link_libraries(rpcs3_lib PRIVATE iconv)
    endif()

    # Unix display manager
    if(X11_FOUND)
        target_link_libraries(rpcs3_lib PRIVATE X11::X11 xkbcommon-x11 xkbcommon)
    elseif(USE_VULKAN AND UNIX AND NOT WAYLAND_FOUND AND NOT APPLE AND NOT ANDROID)
        # Wayland has been checked in 3rdparty/CMakeLists.txt already.
        message(FATAL_ERROR "RPCS3 requires either X11 or Wayland (or both) for Vulkan.")
    endif()

    if(WIN32)
        target_link_libraries(rpcs3_lib PRIVATE ws2_32 Iphlpapi Winmm Psapi gdi32 setupapi)
    else()
        target_link_libraries(rpcs3_lib PRIVATE ${CMAKE_DL_LIBS})
    endif()

    if(USE_PRECOMPILED_HEADERS)
        target_precompile_headers(rpcs3_lib PRIVATE stdafx.h)
    endif()

    # Build rpcs3 executable
    add_executable(rpcs3 WIN32 MACOSX_BUNDLE)
    if(WIN32)
        target_sources(rpcs3 PRIVATE rpcs3.rc)
        target_compile_definitions(rpcs3 PRIVATE UNICODE _UNICODE)
    elseif(APPLE)
        target_sources(rpcs3 PRIVATE rpcs3.icns update_helper.sh)
        set_source_files_properties(update_helper.sh PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
        set_target_properties(rpcs3
            PROPERTIES
                MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/rpcs3.plist.in")
    endif()

    target_sources(rpcs3
        PRIVATE
            main.cpp
    )

    target_link_libraries(rpcs3
        PRIVATE
            rpcs3_lib
    )

    if(USE_PRECOMPILED_HEADERS)
        target_precompile_headers(rpcs3 PRIVATE stdafx.h)
    endif()

    # Copy icons to executable directory
    if(APPLE)
        qt_finalize_target(rpcs3)
        add_custom_command(TARGET rpcs3 POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy ${CMAKE_CURRENT_SOURCE_DIR}/rpcs3.icns $<TARGET_FILE_DIR:rpcs3>/../Resources/rpcs3.icns
            COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/bin/Icons $<TARGET_FILE_DIR:rpcs3>/../Resources/Icons
            COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/bin/GuiConfigs $<TARGET_FILE_DIR:rpcs3>/../Resources/GuiConfigs
            COMMAND "${MACDEPLOYQT_EXECUTABLE}" "${PROJECT_BINARY_DIR}/bin/rpcs3.app" "$<$<CONFIG:Debug,RelWithDebInfo>:-no-strip>")
    elseif(UNIX)
        add_custom_command(TARGET rpcs3 POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/bin/Icons $<TARGET_FILE_DIR:rpcs3>/Icons
            COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/bin/GuiConfigs $<TARGET_FILE_DIR:rpcs3>/GuiConfigs)
    elseif(WIN32)
        add_custom_command(TARGET rpcs3 POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/bin/Icons $<TARGET_FILE_DIR:rpcs3>/Icons
            COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/bin/GuiConfigs $<TARGET_FILE_DIR:rpcs3>/GuiConfigs
            COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/bin/test $<TARGET_FILE_DIR:rpcs3>/test
            COMMAND "${WINDEPLOYQT_EXECUTABLE}" --no-compiler-runtime --no-opengl-sw --no-patchqt
                --no-system-d3d-compiler --no-system-dxc-compiler --no-quick-import
                --plugindir "$<IF:$<CXX_COMPILER_ID:MSVC>,$<TARGET_FILE_DIR:rpcs3>/plugins,$<TARGET_FILE_DIR:rpcs3>/share/qt6/plugins>"
                --translationdir "$<IF:$<CXX_COMPILER_ID:MSVC>,$<TARGET_FILE_DIR:rpcs3>/translations,$<TARGET_FILE_DIR:rpcs3>/share/qt6/translations>"
                --verbose 0 "$<TARGET_FILE:rpcs3>")
    endif()

    # Unix installation
    if(UNIX AND NOT APPLE)
        # Install the binary
        install(TARGETS rpcs3 RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
        # Install the application icon and menu item
        install(FILES rpcs3.svg
            DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/icons/hicolor/scalable/apps)
        install(FILES rpcs3.png
            DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/icons/hicolor/48x48/apps)
        install(FILES rpcs3.desktop
            DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/applications)
        install(FILES rpcs3.metainfo.xml
            DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/metainfo)
        # Install other files
        install(DIRECTORY ../bin/Icons
            DESTINATION ${CMAKE_INSTALL_DATADIR}/rpcs3)
        install(DIRECTORY ../bin/GuiConfigs
            DESTINATION ${CMAKE_INSTALL_DATADIR}/rpcs3)
        install(DIRECTORY ../bin/test
            DESTINATION ${CMAKE_INSTALL_DATADIR}/rpcs3)
    endif()
endif()

# Unit tests
if(BUILD_RPCS3_TESTS)
    find_package(GTest REQUIRED)

    message(STATUS "Building unit tests...")

    add_executable(rpcs3_test)

    target_sources(rpcs3_test
        PRIVATE
            tests/test.cpp
            tests/test_bit_set.cpp
            tests/test_fmt.cpp
            tests/test_pair.cpp
            tests/test_tuple.cpp
            tests/test_simple_array.cpp
            tests/test_address_range.cpp
            tests/test_sys_fs.cpp
            tests/test_rsx_cfg.cpp
            tests/test_rsx_fp_asm.cpp
            tests/test_dmux_pamf.cpp
            tests/test_spu_analyser.cpp
            tests/test_types_util.cpp
    )

    target_link_libraries(rpcs3_test
        PRIVATE
            rpcs3_lib
            rpcs3_emu
            GTest::gtest
            GTest::gmock
    )

    target_include_directories(rpcs3_test
        PUBLIC
            ${CMAKE_CURRENT_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}/..
    )

    include(GoogleTest)
    gtest_discover_tests(rpcs3_test)

    if(RUN_RPCS3_TESTS)
        add_custom_target(run_tests
            ALL
            COMMAND ${CMAKE_CTEST_COMMAND} -j -VV --output-on-failure
            DEPENDS rpcs3_test
     )
    endif()
endif()
