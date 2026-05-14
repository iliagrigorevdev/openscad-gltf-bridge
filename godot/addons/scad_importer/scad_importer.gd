@tool
extends EditorImportPlugin

enum Presets { DEFAULT }

func _get_importer_name():
    return "openscad.gltf.importer"

func _get_visible_name():
    return "OpenSCAD GLTF Importer"

func _get_recognized_extensions():
    return PackedStringArray(["scad"])

func _get_save_extension():
    return "scn"

func _get_resource_type():
    return "PackedScene"

func _get_preset_count():
    return 1

func _get_preset_name(preset_index):
    return "Default"

func _get_import_options(path, preset_index):
    return [
        {"name": "auto_smooth", "default_value": true},
        {"name": "crease_angle", "default_value": 30.0},
        {"name": "resize", "default_value": 0.0}
    ]

func _get_import_order():
    return 0

func _get_option_visibility(path, option_name, options):
    return true

func _import(source_file, save_path, options, platform_variants, gen_files):
    var global_source = ProjectSettings.globalize_path(source_file)
    var temp_glb_path = ProjectSettings.globalize_path("user://temp_scad_import.glb")
    
    # 1. Prepare JSON options for your Node script
    var js_options = {
        "autoSmooth": options["auto_smooth"],
        "creaseAngle": options["crease_angle"]
    }
    if options["resize"] > 0.0:
        js_options["resize"] = options["resize"]
        
    var json_options_str = JSON.stringify(js_options)

    # Encode to Base64 to protect it from shell quote-stripping
    var b64_options = Marshalls.utf8_to_base64(json_options_str)

    # 2. Setup NPX command
    var npx_command = "npx"
    var args = PackedStringArray()
    
    if OS.get_name() == "Windows":
        npx_command = "cmd.exe"
        args.append("/c")
        args.append("npx")
    
    args.append("--yes") 
    
    # Tell npx to use your package
    args.append("-p")
    args.append("github:iliagrigorevdev/openscad-gltf-bridge#godot")

    # The actual CLI command defined in package.json "bin"
    args.append("scad-process")

    # Pass our 3 arguments: input, output, options
    args.append(global_source)
    args.append(temp_glb_path)
    args.append(b64_options)

    # 3. Execute NPX
    var output = []
    print("Importing SCAD via npx... (This might take a few seconds on the first run)")
    var exit_code = OS.execute(npx_command, args, output, true)
    
    if exit_code != 0:
        push_error("Failed to compile SCAD file. Ensure Node.js is installed.")
        push_error("npx output: ", "\n".join(output))
        return ERR_COMPILATION_FAILED

    # 4. Load the generated GLB
    var gltf_doc = GLTFDocument.new()
    var gltf_state = GLTFState.new()
    var err = gltf_doc.append_from_file(temp_glb_path, gltf_state)
    
    # 5. Clean up the temporary file immediately
    if FileAccess.file_exists(temp_glb_path):
        DirAccess.remove_absolute(temp_glb_path)

    if err != OK:
        push_error("Failed to parse the generated GLB.")
        return err

    # 6. Convert to Godot PackedScene
    var generated_scene = gltf_doc.generate_scene(gltf_state)
    if not generated_scene:
        return ERR_CANT_CREATE

    var packed_scene = PackedScene.new()
    packed_scene.pack(generated_scene)
    generated_scene.queue_free()

    # 7. Save to the internal .godot/imported folder
    var final_save_path = "%s.%s" % [save_path, _get_save_extension()]
    return ResourceSaver.save(packed_scene, final_save_path)
