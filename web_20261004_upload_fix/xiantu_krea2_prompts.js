export const KREA2_COMMON_NEGATIVE = "";

export const KREA2_TEXT_PRESET = {
    id: "free_create",
    label: "自由编辑",
    description: "用自然语言描述想看到的画面；先写核心想法，再逐步补充风格、构图、光线和材质。",
    prompt: "",
    demo: "",
};

// Krea-2 uses concise user-authored text. Reference images are passed separately by
// the backend vision input, so the UI must not expose or apply built-in prompt/demo text.
const edit = (description, _prompt, _demo, options) => ({ description, prompt: "", demo: "", ...(options ? { options } : {}) });

export const KREA2_EDIT_CONTENT = {
    free_edit: edit(
        "单图自由编辑：用一句明确指令写出要改变的内容，并说明其余部分保持不变。",
        "Edit <image1> according to the instruction. Change only the requested content and preserve the subject identity, composition, camera perspective, lighting, and all unrelated details.",
        "In <image1>, change the red umbrella to a transparent umbrella covered with small raindrops. Keep the woman, her face, coat, pose, street composition, wet pavement, and night lighting unchanged."
    ),
    outfit: edit(
        "服装迁移：第一张图提供人物，第二张图提供服装；写清保留人物身份与姿态。",
        "Dress the person in <image1> in the complete outfit shown in <image2>. Preserve the person’s identity, face, hair, body proportions, pose, hands, camera framing, and background. Match the garment construction, fabric, color, pattern, and accessories from <image2>.",
        "Dress the woman in <image1> in the ivory linen suit from <image2>, including the double-breasted jacket, wide-leg trousers, brown leather belt, and gold buttons. Keep her face, short black hair, standing pose, office window background, and soft morning light unchanged."
    ),
    replace_person: edit(
        "人物替换：以第一张图为场景和姿态，以第二张图为人物身份。",
        "Replace the main person in <image1> with the person from <image2>. Preserve the identity, facial structure, skin tone, hair, and distinctive features from <image2>, while keeping the pose, action, framing, background, perspective, and lighting of <image1>.",
        "Replace the chef in <image1> with the man from <image2>. Keep his recognizable face, salt-and-pepper hair, and round glasses, while preserving the chef’s cooking pose, white uniform, restaurant kitchen, camera angle, steam, and warm overhead light from <image1>."
    ),
    replace_background: edit(
        "背景替换：保留第一张图主体，把第二张图作为目标环境并统一透视和光线。",
        "Keep the complete foreground subject from <image1> unchanged and place it into the environment shown in <image2>. Match scale, perspective, depth of field, color temperature, contact shadows, reflections, and environmental light.",
        "Keep the silver motorcycle and rider from <image1> unchanged and place them on the coastal road in <image2>. Match the road perspective, late-afternoon sun direction, ocean haze, tire contact shadows, and warm reflected light."
    ),
    pose_transfer: edit(
        "姿势迁移：第一张图提供人物身份，第二张图提供身体姿势。",
        "Make the person in <image1> perform the body pose and gesture shown in <image2>. Preserve the identity, face, hairstyle, body type, clothing, and visual style from <image1>; keep anatomy, balance, hands, and occlusion natural.",
        "Make the dancer in <image1> adopt the extended arabesque pose from <image2>. Preserve her face, braided hair, blue rehearsal dress, studio setting, and side lighting; keep the supporting foot, hands, balance, and fabric movement anatomically natural."
    ),
    hair_makeup: edit(
        "发型妆容：只改变头发与妆容，可用第二张图提供参考。",
        "Edit only the hairstyle and makeup of the person in <image1>, using <image2> as the appearance reference when provided. Preserve identity, face shape, facial proportions, expression, clothing, pose, framing, and background.",
        "Give the woman in <image1> the soft shoulder-length copper waves and understated peach makeup from <image2>. Keep her identity, freckles, eye shape, expression, black dress, seated pose, grey studio backdrop, and softbox lighting unchanged."
    ),
    multi_person: edit(
        "多人融合：逐张指定人物，并写清站位、尺度、遮挡和统一光线。",
        "Combine the people from the provided reference images into one coherent scene. Preserve each person’s separate identity, face, hair, body proportions, and clothing; specify their placement and unify scale, perspective, eyelines, occlusion, environmental light, and contact shadows.",
        "Place the woman from <image1> on the left side of a café table and the man from <image2> on the right, with the child from <image3> standing between them. Preserve all three identities and outfits; use consistent seated scale, window light, table occlusion, and floor shadows in a bright neighborhood café."
    ),
    character_sheet: edit(
        "角色设定：从参考角色生成统一设计语言的设定页，保持身份与服装结构。",
        "Create a clean character design sheet based on <image1>. Preserve the exact identity, face, hairstyle, body proportions, outfit construction, colors, and signature accessories across every view. Use a neutral background and consistent scale and lighting.",
        "Create a professional character sheet for the silver-haired courier in <image1>: one full-body front view, one three-quarter view, one back view, and three small head studies. Keep the same amber eyes, asymmetrical bob, orange utility jacket, black cargo trousers, messenger bag, and worn boots on a warm-grey background."
    ),
    four_views: edit(
        "四视图：生成正面、左侧、背面、右侧，保持比例、服装与尺度一致。",
        "Create four orthographic full-body views of the character in <image1>: front, left profile, back, and right profile. Preserve identity, body proportions, hairstyle, outfit construction, colors, and accessories; use identical scale, neutral stance, even light, and a plain background.",
        "Create front, left, back, and right orthographic views of the armored mechanic in <image1>. Keep the square face, shaved sides, braided topknot, olive work suit, red shoulder armor, tool belt, gloves, and heavy boots identical in all four views, evenly spaced on a light neutral background."
    ),
    expressions: edit(
        "表情表：只改变表情，保持同一人物的脸型、发型、视角和光线。",
        "Create an expression sheet from <image1>. Keep the same identity, face shape, hairstyle, camera angle, and lighting in every panel; vary only the requested facial expression with natural eyes, mouth, cheeks, and brows.",
        "Create a six-panel head-and-shoulders expression sheet for the boy in <image1>: calm, delighted, suspicious, angry, frightened, and tearful. Keep his round face, green eyes, curly brown hair, yellow hoodie, three-quarter angle, and soft daylight identical across all panels."
    ),
    pose_sheet: edit(
        "动作姿势表：保持同一角色设计，生成多个清晰且不重叠的全身动作。",
        "Create a full-body pose sheet for the character in <image1>. Preserve identity, body proportions, hairstyle, clothing, colors, and accessories in every pose. Separate the figures clearly and keep anatomy, balance, hands, and perspective consistent.",
        "Create five full-body action poses for the desert ranger in <image1>: relaxed standing, crouching with binoculars, sprinting, drawing a bow, and kneeling beside a map. Keep the same face, scarf, sand-colored coat, leather gear, boots, and bow design in every pose on a plain beige background."
    ),
    outfit_sheet: edit(
        "服装套图：保持人物身份和体型，展示多套明确不同的完整服装。",
        "Create an outfit variation sheet for the person in <image1>. Preserve identity, face, hairstyle, body proportions, neutral pose, scale, and lighting; change only the complete outfit in each clearly separated full-body version.",
        "Create four outfit variations for the woman in <image1>: minimalist office tailoring, weekend denim and knitwear, black evening dress with silver jewelry, and lightweight hiking gear. Keep her face, long dark hair, body proportions, front-facing pose, and soft studio light identical."
    ),
    product_scene: edit(
        "商品场景：保持商品结构和品牌细节，把商品放入可信使用环境。",
        "Place the product from <image1> into the environment shown in <image2>, or into the described target scene. Preserve the exact product shape, proportions, materials, label, logo, and color; match scale, perspective, reflections, contact shadow, and environmental light.",
        "Place the matte-black espresso machine from <image1> on the walnut counter of the sunlit kitchen in <image2>. Preserve every control, pressure gauge, chrome handle, logo, and surface finish; match the counter perspective, warm window light, metal reflections, and contact shadow."
    ),
    product_angles: edit(
        "商品多角度：在统一棚拍条件下展示同一商品的多个角度。",
        "Create a multi-angle product sheet from <image1>. Preserve the exact product design, dimensions, materials, colors, logo, labels, and component placement in every view. Use consistent scale, background, camera height, and studio lighting.",
        "Create four views of the white wireless speaker in <image1>: front, three-quarter front, side, and back. Keep the oval housing, woven grille, copper volume ring, ports, and small ‘AURA’ logo identical, with consistent soft shadows on a pale-grey studio background."
    ),
    model_showcase: edit(
        "模特展示：把商品或服装自然穿戴到人物身上，保持人物与商品结构。",
        "Create a model showcase using the person in <image1> and the product or garment in <image2>. Preserve the person’s identity and natural anatomy, and preserve the product’s exact construction, materials, colors, pattern, logo, and fit. Use believable contact, folds, shadows, and scale.",
        "Show the man from <image1> wearing the charcoal technical jacket from <image2> in a full-body street-style photograph. Preserve his face, short curls, body type, and relaxed stance; reproduce the jacket’s taped seams, asymmetric pockets, matte fabric, and orange zipper pulls exactly."
    ),
    advertising: edit(
        "商业广告：保留商品真实结构，重新设计有明确主视觉和留白的广告画面。",
        "Turn the product in <image1> into a polished advertising image. Preserve its exact structure, material, color, label, logo, and readable brand text. Build a coherent art direction with a clear focal point, controlled props, deliberate negative space, realistic reflections, and professional lighting.",
        "Create a premium launch advertisement for the cobalt-blue watch in <image1>. Place it upright on dark volcanic glass with a thin arc of water behind it, cool rim light, crisp metal reflections, and generous empty space in the upper left. Keep the case, crown, blue dial, indices, hands, and ‘NORTH/07’ text exact."
    ),
    remove_content: edit(
        "内容移除：明确要删除的对象，并要求按周围结构自然补全。",
        "Remove only the specified object from <image1> and reconstruct the hidden background so it matches the surrounding geometry, texture, pattern, perspective, lighting, reflections, and shadows. Preserve everything else unchanged.",
        "Remove the parked red bicycle from the lower-right corner of <image1>. Reconstruct the cobblestone pavement, curb edge, wall texture, and soft afternoon shadow behind it; keep all buildings, pedestrians, signs, framing, and color grading unchanged."
    ),
    transparent: edit(
        "主体分离：生成干净、完整、边缘自然的孤立主体；透明能力取决于当前输出链路。",
        "Isolate the main subject from <image1>. Preserve the complete silhouette, fine hair or edge detail, materials, internal holes, and original proportions. Remove the environment and place the subject on a clean uniform background suitable for later cutout processing.",
        "Isolate the potted monstera plant from <image1>, including every leaf edge, thin stem, aerial root, ceramic pot, and natural contact shadow. Remove the room and place the complete plant on a perfectly even light-grey background with no extra objects."
    ),
    add_object: edit(
        "添加物体：写清新增物体的位置、尺度、朝向、材质以及与场景的接触关系。",
        "Add the specified object to <image1> at the requested position. Match scene scale, camera perspective, depth of field, material response, light direction, color temperature, reflections, occlusion, and contact shadow. Preserve all existing content.",
        "Add a small brushed-steel desk lamp to the back-left corner of the wooden desk in <image1>, angled toward the open notebook. Match the camera perspective and evening room light, add a warm pool of light on the paper and a natural base shadow, and keep every existing object unchanged."
    ),
    edit_text: edit(
        "文字修改：把目标文字逐字放在英文双引号中，并保留原版式、字体和材质。",
        "Replace only the specified text in <image1> with the exact quoted text. Preserve the original layout, position, font character, weight, size, spacing, color, print or surface texture, perspective, and lighting. Do not add extra text.",
        "Replace the storefront sign text in <image1> with exactly \"MORNING TIDE\". Preserve the condensed cream lettering, centered alignment, letter spacing, weathered painted texture, sign perspective, rust marks, and warm sunlight; change no other text or object."
    ),
    style_transfer: edit(
        "风格迁移：保留第一张图内容与构图，把第二张图的媒介、笔触和色彩语言迁移过去。",
        "Restyle the content of <image1> using the visual language of <image2>. Preserve the subjects, identities, object count, spatial layout, pose, camera framing, and scene structure from <image1>; transfer the medium, palette, line quality, texture, brushwork, contrast, and atmosphere from <image2>.",
        "Transform the harbor scene in <image1> into the layered risograph print style of <image2>. Keep the boats, lighthouse, breakwater, horizon, and exact composition; transfer the limited navy, coral, and mustard palette, offset ink layers, coarse halftone grain, and flat paper texture.",
        [
            ["reference", "参考图风格", "以 <image2> 为唯一风格依据，不额外加载固定风格 LoRA。"],
            ["anime_outline", "二次元描边", "转换为干净的二次元描边插画风格，线条清晰、色块稳定、角色结构完整。"],
            ["retro_anime", "复古动漫", "转换为复古赛璐璐动漫风格，采用克制色彩、手绘轮廓和老式动画质感。"],
            ["cg_game", "CG 游戏角色", "转换为高完成度 CG 游戏角色渲染，保留身份与构图，强化立体材质和电影光影。"],
        ]
    ),
    anime_to_real: edit(
        "二次元转真人：保留角色辨识特征和服装设计，重建为可信真人摄影。",
        "Reconstruct the illustrated character in <image1> as a believable real person. Preserve the character’s recognizable identity cues, face shape, hairstyle and color, outfit design, accessories, pose, expression, composition, and environment; translate them into realistic anatomy, skin, hair, fabric, materials, and photographic light.",
        "Reconstruct the blue-haired swordswoman in <image1> as a real East Asian woman in a cinematic costume portrait. Keep her short cobalt bob, narrow amber eyes, black-and-silver shoulder armor, red scarf, sword position, three-quarter pose, ruined temple background, and sunset rim light. Use natural skin texture, individual hair strands, real metal and fabric, and believable anatomy."
    ),
};

export const KREA2_OFFICIAL_GUIDE = `【Krea 2 提示词说明】

文生图依据 Krea 2 官方提示指南：
1. 使用自然语言描述画面，不需要堆叠标签或固定模板。
2. 可以从一个简短想法开始，让模型探索不同方向；确定方向后再补充媒介、风格、构图、光线、色彩和材质以收窄结果。
3. 长而具体的描述同样有效，但每一项细节应当彼此一致。
4. 需要画面文字时，把要显示的准确文字放在英文双引号中。
5. Krea 2 强项是美学与风格探索；提示词应先说“画什么”，再说“怎样呈现”。

图生图依据 Krea 2 Edit 原作者工作流：
1. 使用直接、自然的编辑指令，例如“把汽车改成哑光黑色”。
2. 明确要改变什么，并明确哪些身份、构图、姿态、物体或背景必须保留。
3. 第一张图通常是被编辑的源图；双参考任务再说明第二张图提供的人物、服装、场景或风格。
4. 两张参考图的顺序必须与功能槽位一致，不要让同一张图承担互相矛盾的职责。
5. 人物编辑优先写身份、脸、头发、体型、姿态和服装的保留范围；场景合成要写尺度、透视、遮挡、接触阴影与统一光线。
6. 当前链路使用图像语义条件与参考图 latent；参考图宽高比接近输出画幅时，保真度更稳定。
7. Krea 2 官方基础模型本身是文生图模型；本工作台的图生图能力来自 Krea 2 Edit 原作者节点与编辑 LoRA 工作流。

参考来源：krea-ai/krea-2 官方 prompting.md、Krea 官方 Krea 2 指南、lbouaraba/comfyui-krea2edit 原作者 README。`;
