cmake_minimum_required(VERSION 3.20)
project(rpcs3_libghidra LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(GHIDRA_HOME "/home/administrator/Documents/windows-usb4-decomp/tools/ghidra_12.1.3_PUBLIC"
    CACHE PATH "Path to Ghidra 12.1.3 distribution")
set(GHIDRA_CPP_DIR "${GHIDRA_HOME}/Ghidra/Features/Decompiler/src/decompile/cpp")

find_package(ZLIB REQUIRED)

set(GHIDRA_LIBDECOMP_NAMES
    # CORE
    xml marshal space float address pcoderaw translate opcodes globalcontext
    # DECCORE
    capability architecture options graph cover block cast typeop database cpool
    comment stringmanage modelrules fspec action loadimage grammar varnode op type
    variable varmap jumptable emulate emulateutil flow userop expression multiprecision
    funcdata funcdata_block funcdata_op funcdata_varnode unionresolve pcodeinject
    heritage prefersplit rangeutil ruleaction subflow blockaction merge double
    transform constseq bitfield coreaction condexe override dynamic crc32 prettyprint
    printlanguage printc printjava memstate opbehavior paramid signature
    # SLEIGH
    sleigh pcodeparse pcodecompile sleighbase slghsymbol
    slghpatexpress slghpattern semantics context slaformat compression filemanage
    # EXTRA (excluding bfd_arch / loadimage_bfd / codedata / analyzesigs)
    callgraph ifacedecomp ifaceterm inject_sleigh interface
    libdecomp loadimage_xml raw_arch rulecompile sleigh_arch testfunction unify xml_arch
)

set(GHIDRA_LIBDECOMP_SRCS)
foreach(name IN LISTS GHIDRA_LIBDECOMP_NAMES)
    list(APPEND GHIDRA_LIBDECOMP_SRCS "${GHIDRA_CPP_DIR}/${name}.cc")
endforeach()

add_library(ghidra_decomp STATIC ${GHIDRA_LIBDECOMP_SRCS})
target_include_directories(ghidra_decomp PUBLIC "${GHIDRA_CPP_DIR}")
target_compile_options(ghidra_decomp PRIVATE -O2 -w)
target_link_libraries(ghidra_decomp PUBLIC ZLIB::ZLIB)

add_executable(ghidra-recomp ghidra_recomp_main.cc)
target_include_directories(ghidra-recomp PRIVATE
    "${GHIDRA_CPP_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/../.."
)
target_compile_definitions(ghidra-recomp PRIVATE
    DEFAULT_GHIDRA_HOME="${GHIDRA_HOME}"
)
target_compile_options(ghidra-recomp PRIVATE -O2 -Wall -Wno-sign-compare)
target_link_libraries(ghidra-recomp PRIVATE ghidra_decomp)
