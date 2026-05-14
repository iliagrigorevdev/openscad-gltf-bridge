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

    # Prevent "inconsistent owner" warnings by stripping owners before shuffling nodes
    _clear_owner_recursive(generated_scene)

    # Convert ImporterMeshInstance3D to standard MeshInstance3D geometry
    var final_scene = _convert_scene(generated_scene)
    if final_scene != generated_scene:
        generated_scene.queue_free()

    # Rename the root node to the original SCAD file's name (e.g. "my_model")
    final_scene.name = source_file.get_file().get_basename()

    # Make sure all children have their owner flag set to the root node
    # so that Godot properly includes them inside the saved PackedScene!
    _set_owner_recursive(final_scene, final_scene)

    var packed_scene = PackedScene.new()
    packed_scene.pack(final_scene)
    final_scene.queue_free()

    # 7. Save to the internal .godot/imported folder
    var final_save_path = "%s.%s" % [save_path, _get_save_extension()]
    return ResourceSaver.save(packed_scene, final_save_path)


# Helper function to swap editor-only importer meshes with game-ready meshes
func _convert_scene(node: Node) -> Node:
    var new_node = node
    
    if node is ImporterMeshInstance3D:
        var mesh_inst = MeshInstance3D.new()
        mesh_inst.name = node.name
        mesh_inst.transform = node.transform
        if node.mesh != null:
            # Extracts the fully baked ArrayMesh with materials from the importer format
            mesh_inst.mesh = node.mesh.get_mesh()
        new_node = mesh_inst
    
    var children = node.get_children()
    for child in children:
        var new_child = _convert_scene(child)
        if new_child != child:
            node.remove_child(child)
            new_node.add_child(new_child)
            child.queue_free()
        else:
            # If the parent was converted but the child wasn't, shift the child to the new parent
            if new_node != node:
                node.remove_child(child)
                new_node.add_child(child)
                
    return new_node

# Helper function to prevent hierarchy warnings
func _clear_owner_recursive(node: Node):
    node.owner = null
    for child in node.get_children():
        _clear_owner_recursive(child)

# Helper function to assign nodes to the root (essential for scene packing)
func _set_owner_recursive(node: Node, root: Node):
    if node != root:
        node.owner = root
    for child in node.get_children():
        _set_owner_recursive(child, root)