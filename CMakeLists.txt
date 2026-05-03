cmake_minimum_required(VERSION 3.20)
project(maximize_detector_script LANGUAGES NONE)

set(SCRIPT_NAME maximize_detector)
set(PACKAGE_FILE "${CMAKE_CURRENT_BINARY_DIR}/${SCRIPT_NAME}.kwinscript")

add_custom_command(
    OUTPUT "${PACKAGE_FILE}"
    COMMAND ${CMAKE_COMMAND} -E tar cf "${PACKAGE_FILE}" --format=zip metadata.json contents
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/metadata.json"
        "${CMAKE_CURRENT_SOURCE_DIR}/contents/code/main.js"
    COMMENT "Packaging ${SCRIPT_NAME}.kwinscript"
    VERBATIM
)

add_custom_target(package_kwinscript ALL DEPENDS "${PACKAGE_FILE}")
