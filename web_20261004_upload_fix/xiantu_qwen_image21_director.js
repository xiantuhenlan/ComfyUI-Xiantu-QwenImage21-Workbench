import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "XiantuQwenImage21Director";
const NODE_TITLE = "闲兔Qwen Image 2.1 工作台";
const MAX_IMAGES = 16;

function linkedStoryboardTask(node) {
    const input = (node.inputs || []).find((item) => String(item.name || "").includes("分镜"));
    if (input?.link == null) return null;
    const graph = node.graph || app.graph;
    const link = graph?.links?.get?.(input.link) || graph?.links?.[input.link] || app.graph?.links?.get?.(input.link) || app.graph?.links?.[input.link];
    const source = graph?.getNodeById?.(link?.origin_id ?? link?.originId) || app.graph?.getNodeById?.(link?.origin_id ?? link?.originId);
    const state = source?.properties?.xiantuStoryboardDirector;
    if (!state || !Array.isArray(state.shots)) return { prompt: "", negative: "", assets: [], label: "分镜任务已接入" };
    const activeAssetId = String(state.active_asset_task_id || "");
    if (activeAssetId) {
        const allAssets = [
            ...(state.characters || []).map((asset) => ({ asset, kind: "角色" })),
            ...(state.scenes || []).map((asset) => ({ asset, kind: "场景" })),
            ...(state.props || []).map((asset) => ({ asset, kind: "道具" })),
        ];
        const jobs = allAssets.filter(({ asset }) => asset?.id).map(({ asset, kind }) => ({ shotId: `asset:${asset.id}`, shotTitle: `${kind}资产`, taskId: `asset:${asset.id}`, slot: "asset_image", label: `${asset.id}｜${asset.name || "未命名"}`, prompt: String(asset.image_prompt || asset.prompt || ""), promptEngine: asset.image_prompt_engine || state.ai?.image_prompt_engine || "Qwen Image 2.1", generationMode: "文生图", negative: String(state.project?.global_negative || ""), refs: [] }));
        const selectedJob = jobs.find((job) => job.taskId === `asset:${activeAssetId}`);
        if (selectedJob) return { source, sourceState: state, jobs, shotId: selectedJob.shotId, taskId: selectedJob.taskId, slot: selectedJob.slot, mode: "资产生图", prompt: selectedJob.prompt, promptEngine: selectedJob.promptEngine, generationMode: "文生图", negative: selectedJob.negative, assets: [], label: `${selectedJob.shotTitle} · ${selectedJob.label}` };
    }
    const shot = state.shots.find((item) => item.id === state.active_shot_id) || state.shots[0] || {};
    const mode = String(shot.video_mode || shot.video_generation_mode || "图生视频");
    const taskId = String(shot.active_image_task_id || "");
    let slot = "start_frame";
    let prompt = String(shot.positive || "");
    let refs = [...(shot.protagonist_refs || []), ...(shot.supporting_refs || []), ...(shot.prop_refs || []), ...(shot.scene_ref ? [shot.scene_ref] : [])];
    if (mode === "首尾帧") {
        const last = taskId.endsWith(":last_frame");
        slot = last ? "last_frame" : "first_frame";
        prompt = String(last ? (shot.last_frame_prompt || shot.positive || "") : (shot.first_frame_prompt || shot.positive || ""));
        refs = last ? (shot.last_frame_asset_refs || refs) : (shot.first_frame_asset_refs || refs);
    } else if (mode === "多参考图") {
        slot = "multi_reference";
        refs = shot.multi_reference_asset_refs || refs;
    }
    const tasksFor = (item) => {
        const itemId = String(item.id || "shot"), itemMode = String(item.video_mode || item.video_generation_mode || "图生视频");
        const commonRefs = [...(item.protagonist_refs || []), ...(item.supporting_refs || []), ...(item.prop_refs || []), ...(item.scene_ref ? [item.scene_ref] : [])];
        const base = { shotId: itemId, shotTitle: item.title || itemId, mode: itemMode, promptEngine: item.image_prompt_engine || "Qwen Image 2.1", generationMode: item.image_generation_mode || (commonRefs.length ? "图片编辑" : "文生图"), negative: String(item.negative || state.project?.global_negative || "") };
        if (itemMode === "首尾帧") return [{ ...base, taskId: `${itemId}:first_frame`, slot: "first_frame", label: "首帧", prompt: item.first_frame_prompt || item.positive || "", refs: item.first_frame_asset_refs?.length ? item.first_frame_asset_refs : commonRefs }, { ...base, taskId: `${itemId}:last_frame`, slot: "last_frame", label: "尾帧", prompt: item.last_frame_prompt || item.positive || "", refs: item.last_frame_asset_refs?.length ? item.last_frame_asset_refs : commonRefs }];
        if (itemMode === "多参考图") return (item.multi_reference_asset_refs?.length ? item.multi_reference_asset_refs : commonRefs).map((ref, index) => ({ ...base, taskId: `${itemId}:reference:${index + 1}`, slot: `reference_${index + 1}`, label: `参考图 ${index + 1}`, prompt: item.positive || "", refs: [ref] }));
        return [{ ...base, taskId: `${itemId}:start_frame`, slot: "start_frame", label: "起始图", prompt: item.positive || "", refs: commonRefs }];
    };
    const jobs = state.shots.flatMap(tasksFor);
    const selectedJob = jobs.find((job) => job.taskId === taskId) || jobs.find((job) => job.shotId === shot.id);
    if (selectedJob) { slot = selectedJob.slot; prompt = selectedJob.prompt; refs = selectedJob.refs; }
    const allAssets = [...(state.characters || []), ...(state.scenes || []), ...(state.props || [])];
    const images = [];
    const add = (value) => { if (!value) return; if (Array.isArray(value)) return value.forEach(add); if (value.images) add(value.images); if (value.image) add(value.image); const isImage = Boolean(value.filename) || (Boolean(value.name) && (Object.hasOwn(value, "subfolder") || ["input", "output", "temp"].includes(String(value.type || "")))); if (isImage && !images.some((item) => (item.name || item.filename) === (value.name || value.filename) && String(item.subfolder || "") === String(value.subfolder || ""))) images.push(value); };
    refs.forEach((id) => add(allAssets.find((asset) => asset.id === id)));
    add(shot.assets || []);
    Object.values(shot.image_results || {}).forEach((record) => add(record));
    return { source, sourceState: state, jobs, shotId: shot.id, taskId: selectedJob?.taskId || taskId || `${shot.id}:${slot}`, slot, mode, prompt, promptEngine: selectedJob?.promptEngine || shot.image_prompt_engine || "Qwen Image 2.1", generationMode: selectedJob?.generationMode || shot.image_generation_mode || "文生图", negative: String(shot.negative || state.project?.global_negative || ""), assets: images.slice(0, MAX_IMAGES), label: `${shot.title || shot.id} · ${mode} · ${slot}` };
}
const STYLE_ID = "xiantu-qwen21-director-style";

const GROUPS = [
    { id: "free", label: "自由编辑", modes: ["free_edit"] },
    { id: "people", label: "人物编辑", modes: ["outfit", "replace_person", "replace_background", "pose_transfer", "hair_makeup", "multi_person"] },
    { id: "character", label: "角色资产", modes: ["character_sheet", "four_views", "expressions", "pose_sheet", "outfit_sheet"] },
    { id: "product", label: "商品设计", modes: ["product_scene", "product_angles", "model_showcase", "advertising"] },
    { id: "process", label: "画面处理", modes: ["remove_content", "transparent", "add_object", "edit_text", "style_transfer", "anime_to_real"] },
];

const T2I_GROUPS = [
    { id: "t2i_general", label: "通用", modes: ["text_to_image"] },
    { id: "t2i_photo", label: "摄影", modes: ["t2i_portrait", "t2i_scene", "t2i_product"] },
    { id: "t2i_art", label: "插画", modes: ["t2i_anime", "t2i_concept"] },
    { id: "t2i_design", label: "文字设计", modes: ["t2i_poster", "t2i_infographic", "t2i_logo"] },
];

const HAND_NEGATIVE = "missing fingers, extra fingers, fused fingers, badly drawn hands, malformed hands, wrong number of fingers";
const COMMON_NEGATIVE = `低清晰度，模糊，结构错误，比例失调，多余肢体，手部畸形，重复主体，身份漂移，服装或物体细节错乱，文字乱码，水印，边缘破损, ${HAND_NEGATIVE}`;

const PRESETS = {
    text_to_image: {
        task: "text", group: "t2i_general", label: "通用生成", description: "按 Qwen Image 2.1 官方八步结构组织主体、空间、文字、材质、光线和整体构图。",
        slots: [],
        prompt: "画面是一幅【画面方向与媒介类型】的【美术风格】作品，主体是【明确主体】，背景采用【环境与主色调】。画面中心呈现【核心动作或核心物体】，上方、左侧、右侧、前景和远景分别安排【逐项写清可见元素及位置】，每个物体具有明确的尺度、遮挡和空间关系。主体表面呈现【材质、颜色与纹理】，环境中的接触阴影、反射和透视保持物理一致。如画面需要可读文字，逐条使用英文双引号写出准确内容，并说明每段文字的位置、字体、字重、颜色和相对大小；如不需要文字，则画面不出现可辨识文字。光线来自【光源方向】，呈现【软硬、色温、阴影和高光特征】。整体构图保持【平衡方式、视觉层级、色彩关系与情绪】，所有用户明确指定的主体、数量、颜色、位置、专有名称和文字保持不变。",
        negative: COMMON_NEGATIVE,
    },
    t2i_portrait: {
        task: "text", group: "t2i_photo", label: "人像摄影", description: "东方人物优先，明确身份表面、姿态、服装、环境、镜头与布光。",
        slots: [],
        options: [
            ["natural", "自然人像", "自然可信的东亚人物摄影，采用东方脸型和东亚五官比例，真实皮肤纹理与独立发丝，避免欧美化面孔、网红脸和过度磨皮。"],
            ["cinematic", "电影人像", "东亚演员电影剧照质感，镜头语言克制，环境叙事清楚，电影级方向性布光与自然景深。"],
            ["editorial", "时尚人像", "东方人物时尚编辑摄影，服装材质、轮廓和配饰清晰，姿态自然，棚拍光线精确而不过度锐化。"],
        ],
        prompt: "画面是一张【半身、全身或特写】人像摄影，主体位于【画面位置】，是一位【东亚人物的性别与年龄阶段】，具有【脸型、五官、肤色、发型与表情】。人物保持【具体姿态、视线与手部动作】，穿着【逐件描述服装、颜色、材质与配饰】，与【背景环境及前后景元素】形成明确空间关系。镜头采用【景别、视角与景深】，背景虚化程度与主体边缘自然。光线来自【方向与光源】，在脸部、发丝和服装表面形成【阴影与高光】。整体构图平衡，色彩统一，人物身份和东方特征清晰可信。",
        negative: "欧美化面孔，西方五官，网红脸，塑料皮肤，过度磨皮，五官畸形，手部错误，多余肢体，服装结构错误，背景杂乱，文字乱码，水印",
    },
    t2i_scene: {
        task: "text", group: "t2i_photo", label: "场景摄影", description: "逐区描述前景、中景、远景、空间关系、天气与光线。",
        slots: [],
        options: [
            ["street", "城市街景", "城市空间具有可信尺度、道路结构、建筑表面、行人和交通关系，远近层次明确。"],
            ["interior", "室内空间", "室内结构、家具、陈设、材质和窗户光线符合真实建筑尺度与使用逻辑。"],
            ["nature", "自然风景", "自然地貌、植被、水体、天空和天气相互一致，前景到远景具有清楚的大气透视。"],
        ],
        prompt: "画面是一张【横向或纵向】写实场景摄影，主要环境是【地点与时间】，整体主色调为【颜色关系】。前景包含【逐项元素】，中景安排【主体、人物或建筑】，远景延伸至【地平线、天际线或室内深处】，左右边缘与角落均有合理内容承接。每个物体的尺寸、透视、遮挡、反射和接触阴影彼此一致，材质清楚可辨。天气与空气状态为【天气、雾气或能见度】。光线来自【太阳、窗户或人工光源的方向】，形成【阴影、高光与色温】。整体构图具有明确视觉焦点、景深层次和统一情绪。",
        negative: "透视错误，比例失调，建筑扭曲，悬浮物体，重复人物，光源冲突，阴影错误，过度锐化，文字乱码，水印",
    },
    t2i_product: {
        task: "text", group: "t2i_photo", label: "商品摄影", description: "明确商品结构、展示台、材质反射、商业留白和棚拍光线。",
        slots: [],
        options: [
            ["studio", "纯净棚拍", "纯净专业棚拍，背景与展示台克制，产品轮廓、材质和接触阴影清晰。"],
            ["lifestyle", "生活场景", "商品置于符合用途的真实生活场景，周围道具少而准确，主体始终最突出。"],
            ["luxury", "高端广告", "高端商业广告质感，使用精确轮廓光、克制反射和高级材质背景，保留充足视觉留白。"],
        ],
        prompt: "画面是一张专业商品摄影，绝对主体是【商品名称、结构、数量、颜色与品牌文字】，位于画面【具体位置】，放置在【展示台或使用场景】上。商品的【金属、塑料、玻璃、皮革、织物或其他材质】呈现准确纹理、反射、透明度与边缘细节，结构比例完整且不变形。背景采用【颜色、材质与空间层次】，周围只安排【逐项道具及位置】，并为标题或价格信息保留【具体留白区域】。如需要可读文字，所有品牌名、标题和数字均使用英文双引号逐字写出。主光来自【方向】，辅光与轮廓光控制反射和阴影，商品与台面接触自然。整体构图简洁、有层级并突出商品。",
        negative: "商品变形，结构错误，数量错误，品牌错误，文字乱码，反射错误，悬浮，边缘破损，主体不突出，背景杂乱，廉价质感，水印",
    },
    t2i_anime: {
        task: "text", group: "t2i_art", label: "二次元插画", description: "明确角色、动作、服装、场景、镜头和插画媒介，避免身份与肢体漂移。",
        slots: [],
        options: [
            ["anime", "动画赛璐璐", "清晰动画赛璐璐上色，线条干净，色块明确，阴影层级克制。"],
            ["semi", "半写实动漫", "半写实动漫插画，保留东方角色审美，人体结构可信，材质与光影细腻。"],
            ["comic", "漫剧画面", "高完成度漫剧画面，角色表演明确，电影化构图，背景支持剧情但不抢主体。"],
        ],
        prompt: "画面是一幅【风格】二次元插画，核心角色是【身份、性别、年龄阶段和辨识特征】，位于【画面位置】，正在【具体动作】，表情为【具体情绪】。角色具有【东方脸型、发型、发色与五官特征】，穿着【逐件服装、颜色、材质和配饰】，身体比例、手部和动作重心自然。前景、中景、远景分别包含【逐项场景元素及位置】，镜头采用【景别、视角与透视】，构图清楚呈现角色与环境关系。光线来自【方向与类型】，色彩采用【主色、辅色与强调色】。整体画面保持统一线条语言、材质表现和叙事情绪，不出现无关文字。",
        negative: "欧美化面孔，身份漂移，五官畸形，多余肢体，手部错误，比例失调，服装结构错误，背景透视错误，线条混乱，文字乱码，水印",
    },
    t2i_concept: {
        task: "text", group: "t2i_art", label: "概念设计", description: "用于科幻、奇幻、建筑和世界观画面，强调尺度、结构和物理一致性。",
        slots: [],
        options: [
            ["scifi", "科幻概念", "科幻设计具有明确功能结构、材料逻辑、尺度参照和统一技术语言。"],
            ["fantasy", "奇幻概念", "奇幻元素具有统一文化来源、材料工艺和环境因果关系，避免随机堆砌。"],
            ["architecture", "建筑概念", "建筑体量、入口、楼层、结构、材料和周边环境符合可信空间逻辑。"],
        ],
        prompt: "画面是一幅【科幻、奇幻或建筑】概念设计，核心主题是【世界观与主体】，主要结构位于【画面位置】，周围以【人物、车辆、植被或道具】提供尺度参照。主体由【结构分区】组成，使用【逐项材料、颜色、表面状态与功能细节】，各部件连接方式和受力关系可信。前景、中景和远景分别呈现【逐项环境内容】，空间透视、空气状态和天气统一。光线来自【方向】，照亮关键结构并形成可读轮廓。整体构图具有清晰焦点、宏观尺度和一致的设计语言，不出现无关文字与标志。",
        negative: "结构混乱，功能不明，尺度错误，透视错误，随机零件堆砌，材质冲突，重复物体，光源冲突，文字乱码，水印",
    },
    t2i_poster: {
        task: "text", group: "t2i_design", label: "海报文字", description: "所有可读文字必须逐字写入双引号，并明确位置、字体和层级。",
        slots: [],
        options: [
            ["commercial", "商业海报", "商业海报使用明确产品焦点、品牌层级、卖点信息和行动区域。"],
            ["event", "活动海报", "活动海报清楚组织标题、日期、地点、嘉宾或活动信息，阅读顺序明确。"],
            ["movie", "电影海报", "电影海报具有核心人物或场景主视觉、片名、宣传语和演职员信息区域。"],
        ],
        prompt: "画面是一张【主题与风格】海报，背景为【颜色、材质与主要视觉元素】。顶部以【字体、字重、颜色和大小】显示主标题“【准确标题文字】”，标题下方以【样式】显示副标题“【准确副标题】”。画面中心安排【人物、产品或核心图形及位置】，左右区域分别放置【逐项辅助元素】，底部信息区依次显示“【日期】”、“【地点】”和“【其他必要文字】”。所有可读文字保持单一目标语言，逐字准确，不添加未指定的中英双语内容。光线和色彩服务于文字可读性与主视觉层级。整体版式具有明确阅读顺序、对齐关系、留白和视觉焦点。",
        negative: "文字乱码，错字，缺字，多字，中英混排，标题重复，排版错位，层级混乱，主体不突出，边缘裁切，水印",
    },
    t2i_infographic: {
        task: "text", group: "t2i_design", label: "信息图表", description: "按区域枚举标题、数据、图标、流程和说明，保证信息完整可读。",
        slots: [],
        options: [
            ["process", "流程说明", "使用清晰步骤编号、方向关系和对应图标展示完整流程。"],
            ["compare", "对比信息", "使用左右或上下对照结构，比较维度一一对应，视觉权重均衡。"],
            ["data", "数据图表", "图表标题、坐标轴、刻度、图例、系列名称和关键数值全部明确写出。"],
        ],
        prompt: "画面是一张【主题】信息图表，使用【扁平矢量、编辑设计或其他风格】和【主色体系】。顶部标题区显示“【准确标题】”与“【准确副标题】”。主体区域按【从左到右、从上到下或环形】顺序分为【明确数量】个模块，每个模块包含【图标或图形】、标题“【模块标题】”、数值“【准确数值】”和说明“【准确说明】”。如包含图表，逐项写明坐标轴、刻度、图例、系列和单元格文字。底部放置“【来源或结论】”。所有文字逐字准确、字号层级清楚、对齐统一；连接线、箭头和模块关系无歧义。整体设计具有稳定网格、充足留白和清晰阅读顺序。",
        negative: "文字乱码，数据错误，缺少标签，模块数量错误，流程方向错误，箭头混乱，对齐错误，信息拥挤，颜色难辨，水印",
    },
    t2i_logo: {
        task: "text", group: "t2i_design", label: "标志图标", description: "单一主体、简洁轮廓、明确配色；品牌文字按原字符精确呈现。",
        slots: [],
        options: [
            ["symbol", "图形标志", "使用一个清楚的核心符号和简洁负形关系，不添加无关文字。"],
            ["wordmark", "文字标志", "品牌文字是唯一核心，字符、大小写和标点完全按用户输入呈现。"],
            ["app", "应用图标", "图形适合小尺寸识别，轮廓简洁，中心视觉明确，边缘留有安全空间。"],
        ],
        prompt: "画面是一枚【标志、徽章或应用图标】设计，核心概念为【品牌或主题】，画面中心仅保留【核心图形与几何关系】，使用【明确颜色】与【背景颜色】形成清晰对比。轮廓简洁、负形关系明确，在小尺寸下仍可识别。如需要品牌文字，只显示“【准确品牌文字】”，字符、大小写、标点和间距完全保持输入内容，并说明其位于【位置】、采用【字体风格与字重】；如不需要文字，则画面不出现任何可辨识文字。整体构图居中、平衡、边缘留有安全空间，不使用复杂场景和多余装饰。",
        negative: "复杂背景，多余元素，细节过密，轮廓模糊，文字乱码，品牌拼写错误，重复文字，渐变脏乱，边缘裁切，水印",
    },
    free_edit: {
        group: "free", label: "自由编辑", description: "上传原图和参考图，直接描述需要修改的内容。",
        slots: [
            ["source", "待编辑原图", true], ["reference", "补充参考图", false], ["detail", "细节参考", false], ["composition", "构图参考", false],
        ],
        prompt: "根据 <image1> 完成用户指定的图片编辑。只修改提示词明确要求改变的内容，其他人物、物体、构图、光线和画面细节保持一致。",
        negative: COMMON_NEGATIVE,
    },
    outfit: {
        group: "people", label: "智能换装", description: "人物原图与服装参考分开上传，保持人物身份和姿势。",
        slots: [["person", "人物原图", true], ["clothes", "服装参考", true], ["pose", "姿势参考", false], ["scene", "场景参考", false]],
        prompt: "将 <image1> 中人物的服装替换为 <image2> 中的服装。完整保留 <image1> 的人物身份、五官、发型、体型、姿势、手部、构图和背景，准确采用 <image2> 服装的版型、颜色、纹理、材质、图案和配饰，使服装自然贴合身体并符合原图光线。",
        negative: "身份改变，五官改变，发型改变，体型改变，姿势改变，背景改变，服装结构错误，材质丢失，图案错位，配饰缺失，穿模，肢体畸形",
    },
    replace_person: {
        group: "people", label: "人物替换", description: "替换场景中的人物，同时保留原构图和环境。",
        slots: [["canvas", "原场景图", true], ["identity", "目标人物", true], ["identity_detail", "人物补充参考", false]],
        prompt: "将 <image1> 中的主要人物替换为 <image2> 中的人物。准确保留 <image2> 的身份、五官、发型和人物特征，同时保持 <image1> 的姿势、动作、服装关系、镜头构图、背景、光线、透视和遮挡关系自然一致。",
        negative: "身份混合，双重五官，脸部变形，年龄漂移，发型错误，姿势错位，比例失调，背景改变，光线不一致，边缘拼贴感",
    },
    replace_background: {
        group: "people", label: "换背景", description: "保留主体，把人物放入目标背景。",
        slots: [["subject", "主体原图", true], ["background", "目标背景", true], ["lighting", "光线参考", false]],
        prompt: "完整保留 <image1> 中的主体身份、外观、服装、姿势和细节，将背景替换为 <image2> 的场景。匹配目标背景的透视、景深、环境光、色温、阴影和接触关系，使主体自然融入新环境。",
        negative: "主体改变，五官改变，服装改变，姿势改变，比例错误，悬浮感，边缘光错误，透视冲突，背景主体重复",
    },
    pose_transfer: {
        group: "people", label: "姿势迁移", description: "保持人物身份与服装，采用参考动作。",
        slots: [["person", "人物原图", true], ["pose", "姿势参考", true], ["scene", "场景参考", false]],
        prompt: "让 <image1> 中的人物采用 <image2> 的身体姿势和动作。保持 <image1> 的身份、五官、发型、体型、服装和整体风格，保证肢体连接、重心、手部和遮挡关系自然。",
        negative: "身份改变，服装改变，多余肢体，关节错位，手部畸形，姿势僵硬，身体扭曲，重心错误",
    },
    hair_makeup: {
        group: "people", label: "发型妆容", description: "修改发型或妆容，保留身份和其余画面。",
        slots: [["person", "人物原图", true], ["style", "发型妆容参考", false], ["color", "颜色参考", false]],
        prompt: "编辑 <image1> 中人物的发型和妆容；如提供 <image2>，采用其发型、妆容和质感作为参考。严格保留人物身份、脸型、五官比例、表情、服装、姿势、构图和背景。",
        negative: "身份改变，脸型改变，五官漂移，过度磨皮，假面感，发丝粘连，发际线错误，妆容脏乱，背景改变",
    },
    multi_person: {
        group: "people", label: "多人物合成", description: "把多个人物放进同一画面并保持各自身份。",
        slots: [["person1", "人物 1", true], ["person2", "人物 2", true], ["scene", "目标场景", false], ["composition", "人物站位与动作", false]],
        prompt: "将 <image1> 与 <image2> 中的人物共同放入一个统一场景，分别准确保持两人的身份、五官、发型、体型和服装。人物尺度、站位、视线、遮挡、环境光和阴影应符合统一透视；如提供场景参考，则沿用对应场景与构图。",
        negative: "人物身份混合，五官互换，人物融合，重复人物，比例错误，遮挡错误，光线不一致，多余肢体，手部畸形",
    },
    character_sheet: {
        group: "character", label: "角色设定图", description: "制作可复用的标准角色资产。",
        slots: [["character", "角色主参考", true], ["clothes", "服装参考", false], ["props", "道具参考", false], ["style", "美术风格参考", false]],
        options: [
            ["basic", "基础角色卡", "生成纯视觉的专业角色设定卡。画面只包含 1 个完整全身正面主视图、1 个头肩或半身近景细节视图，以及服装、配饰和关键造型元素的独立视觉细节展示。不得生成第二个全身人物，不得生成角色说明栏、参数表、信息卡或文字排版。画面中不得出现任何标题、中文、英文、字母、数字、箭头、说明文字或标签；使用纯净背景、统一比例和均匀光线。"],
            ["full", "全身设定", "生成完整全身角色设定图，清楚呈现头部、服装、鞋履、配饰与道具细节。"],
            ["three", "角色三视图", "生成严格的标准角色三视图转面图。使用横向白色画布，从左到右仅排列 3 个完整全身人物，顺序固定为：第 1 位正面、第 2 位角色左侧 90 度纯侧面、第 3 位背面。三个视图必须是同一角色，等高、等比例，头顶和脚底分别对齐，间距一致；全部改为相同的中性站姿，双臂自然下垂，镜头高度、服装、配饰和光线完全一致。不得重复正面，不得使用三分之四视角，不得出现第 4 个人物。画面中不得生成任何标题、中文、英文、字母、数字、箭头、说明文字或视图标签。"],
            ["expression", "表情设定", "生成同一角色的多种标准表情设定，五官和发型保持一致。"],
            ["action", "动作设定", "生成同一角色的多种标准动作姿势，保持身份、服装和身体比例。"],
            ["props", "道具设定", "生成角色专属道具与配件设定，展示整体、结构与细节。"],
        ],
        prompt: "以 <image1> 为唯一角色身份参考，保持五官、脸型、发型、体型、服装标志和配色完全一致。",
        negative: "身份漂移，视图角色不一致，服装变化，比例不统一，配色变化，重复肢体，任何标题，任何文字，中文，英文，字母，数字，箭头，说明标签，乱码，复杂背景",
    },
    four_views: {
        group: "character", label: "四视图", description: "生成角色正面、左侧面、背面与右侧面标准视图。",
        slots: [["character", "角色主参考", true], ["clothes", "服装参考", false], ["detail", "细节参考", false]],
        options: [
            ["single", "单张四视图", "生成严格的标准角色四视图转面图。使用宽幅横向白色画布，平均划分为 4 个等宽区域，从左到右仅排列 4 个完整全身人物，顺序固定为：第 1 位正面、第 2 位角色左侧 90 度纯侧面、第 3 位背面、第 4 位角色右侧 90 度纯侧面。四个视图必须是同一角色，等高、等比例，头顶和脚底分别对齐，人物中心与间距一致；全部改为相同的中性站姿，双臂自然下垂，镜头高度、服装、配饰和光线完全一致。不得重复任何视角，不得用正面替代侧面，不得使用三分之四视角。画面中不得生成任何标题、中文、英文、字母、数字、箭头、说明文字或视图标签。"],
            ["separate", "分别生成", "生成一个指定角度的标准角色视图；当前任务保持全身、中性站姿、纯色背景，便于后续分别排队生成四个角度。"],
            ["unify", "统一现有视图", "统一输入视图中的人物身份、比例、服装、配色和光线，整理为规范的四视图设定排版。"],
        ],
        prompt: "以 <image1> 中的角色为唯一身份参考，只保留角色身份、五官、发型、体型、服装、配饰、材质和颜色，不沿用原图动作；所有视图保持完全一致。",
        negative: "不同视图身份不一致，服装变化，发型变化，比例漂移，左右混乱，透视夸张，动作不一致，任何标题，任何文字，中文，英文，字母，数字，箭头，说明标签，乱码，复杂背景",
    },
    expressions: {
        group: "character", label: "表情九宫格", description: "生成同一角色的标准表情资产。",
        slots: [["character", "角色主参考", true], ["expression", "表情风格参考", false]],
        prompt: "以 <image1> 为唯一身份参考，生成同一角色的九宫格表情设定：平静、微笑、大笑、愤怒、悲伤、惊讶、害怕、疑惑和坚定。所有格子保持相同五官、脸型、发型、服装、画幅、视角和光线。",
        negative: "身份变化，脸型变化，发型变化，年龄漂移，格子数量错误，表情重复，五官畸形，文字乱码",
    },
    pose_sheet: {
        group: "character", label: "动作姿势表", description: "生成同一角色的多种动作姿势。",
        slots: [["character", "角色主参考", true], ["pose", "动作参考", false], ["prop", "互动道具", false]],
        prompt: "以 <image1> 为唯一角色参考，生成同一角色的标准动作姿势表。保持身份、体型、服装和配饰一致，动作清晰、重心合理、肢体完整，各姿势互不遮挡并使用纯净背景。",
        negative: "身份变化，服装变化，身体比例漂移，多余肢体，关节错位，手部畸形，姿势重复，人物重叠",
    },
    outfit_sheet: {
        group: "character", label: "服装方案", description: "为同一角色生成多套统一服装方案。",
        slots: [["character", "角色主参考", true], ["outfit1", "服装参考 1", false], ["outfit2", "服装参考 2", false], ["outfit3", "服装参考 3", false]],
        prompt: "以 <image1> 为唯一人物身份参考，生成同一角色的多套服装方案展示。每个方案保持相同五官、发型、体型、姿势、画幅和光线，只改变服装设计，并准确呈现参考服装的版型、材质、纹理、颜色和配饰。",
        negative: "身份变化，体型变化，姿势变化，服装方案重复，材质错误，图案错乱，配饰缺失，人物比例不一致",
    },
    product_scene: {
        group: "product", label: "商品换场景", description: "保留商品结构，把商品放入目标环境。",
        slots: [["product", "商品原图", true], ["scene", "目标场景", true], ["composition", "构图参考", false]],
        prompt: "完整保留 <image1> 商品的造型、比例、材质、颜色、品牌标识和全部细节，将商品自然放入 <image2> 的场景。匹配场景透视、台面接触、环境光、反射和阴影，生成专业商业摄影效果。",
        negative: "商品变形，结构改变，颜色改变，标识错误，文字乱码，比例错误，悬浮，阴影错误，反射错误，场景杂乱",
    },
    product_angles: {
        group: "product", label: "商品多角度", description: "制作统一的商品多视角展示。",
        slots: [["product", "商品主参考", true], ["detail", "商品细节参考", false]],
        prompt: "以 <image1> 为唯一商品参考，生成正面、侧面、背面和三分之四视角的专业商品多角度展示。所有视图严格保持结构、比例、材质、颜色、纹理、品牌标识和细节一致，使用统一背景与棚拍光线。",
        negative: "商品结构漂移，比例变化，颜色变化，标识错误，文字乱码，视角重复，细节缺失，背景不一致",
    },
    model_showcase: {
        group: "product", label: "模特展示", description: "让模特自然展示指定商品。",
        slots: [["product", "商品原图", true], ["model", "模特参考", true], ["pose", "姿势构图参考", false], ["scene", "场景参考", false]],
        prompt: "让 <image2> 中的模特自然展示或使用 <image1> 中的商品。准确保持商品结构、材质、颜色和品牌细节，同时保持模特身份、体型和自然姿态，确保接触、握持、穿戴、比例、光线与阴影真实。",
        negative: "商品变形，品牌错误，模特身份变化，穿模，握持错误，手部畸形，比例错误，悬浮，光线不一致",
    },
    advertising: {
        group: "product", label: "广告主图", description: "根据商品和构图参考制作商业主视觉。",
        slots: [["product", "商品原图", true], ["scene", "背景风格", false], ["composition", "广告排版参考", false]],
        prompt: "以 <image1> 商品为绝对主体，制作高完成度商业广告主图。严格保留商品结构、材质、颜色、品牌与文字细节，设计清晰的视觉层级、留白、光影、背景和展示台，形成适合发布的专业主视觉。",
        negative: "商品变形，品牌错误，文字乱码，主体不突出，构图拥挤，廉价质感，材质错误，边缘破损，过度装饰",
    },
    remove_content: {
        group: "process", label: "删除内容", description: "删除物体、文字或获授权图片中的水印并自然补全。",
        slots: [["source", "待处理原图", true], ["mark", "区域标记图", false]],
        prompt: "从 <image1> 中移除用户指定的物体、文字或遮挡内容，并根据周围纹理、结构、透视、光线和背景自然补全空缺区域。除指定区域外，其他画面保持不变。仅处理自有或已获授权的素材。",
        negative: "残留文字，残留边缘，重复纹理，补全断裂，涂抹痕迹，结构扭曲，其他区域改变，画质下降",
    },
    transparent: {
        group: "process", label: "透明背景", description: "提取主体并输出干净 RGBA 透明背景。",
        slots: [["source", "主体原图", true], ["edge", "边缘细节参考", false]],
        prompt: "从 <image1> 中精确提取主要主体，完整保留主体的真实颜色、材质、半透明区域、发丝、毛发和细小边缘，移除全部背景并输出原生 RGBA 透明背景图。边缘干净自然，无白边、黑边和背景残留。",
        negative: "不透明背景，棋盘格背景，纯白背景，纯黑背景，白边，黑边，背景残留，主体缺失，边缘锯齿，发丝丢失",
    },
    add_object: {
        group: "process", label: "添加物体", description: "把参考物体自然加入原画面。",
        slots: [["source", "原始画面", true], ["object", "目标物体", true], ["placement", "物体摆放位置", false]],
        prompt: "将 <image2> 中的物体自然添加到 <image1> 的指定位置。准确保持物体结构、材质、颜色和细节，并匹配 <image1> 的尺度、透视、景深、环境光、接触阴影、反射和遮挡关系；其他区域保持不变。",
        negative: "物体变形，比例错误，悬浮，阴影错误，透视冲突，边缘拼贴感，原画面改变，重复物体",
    },
    edit_text: {
        group: "process", label: "修改文字", description: "替换图片中的中英文文字并保留原设计。",
        slots: [["source", "含文字原图", true], ["font", "文字样式参考", false]],
        prompt: "修改 <image1> 中用户指定的文字内容。新文字必须准确、清晰、完整，保持原位置、字号、字体风格、字重、颜色、透视、材质、排版和光影效果，其他图像内容不变。",
        negative: "文字错误，乱码，缺字，多字，拼写错误，字体不一致，排版错位，文字模糊，背景改变",
    },
    style_transfer: {
        group: "process", label: "风格转换", description: "保持内容结构，将画面转换为目标风格。",
        slots: [["source", "内容原图", true], ["style", "风格参考", true], ["detail", "细节参考", false]],
        prompt: "保持 <image1> 的主体、身份、动作、空间结构和构图，将整体视觉风格转换为 <image2> 的美术语言。准确迁移色彩、材质、笔触、光影和画面质感，同时保证内容清晰可辨。",
        negative: "主体改变，身份漂移，构图改变，内容缺失，风格混杂，细节糊化，颜色脏乱，结构变形",
    },
    anime_to_real: {
        group: "process", label: "二次元转写实", description: "把动漫角色重建为可信真人，同时保留角色身份、服装、姿势和构图。",
        slots: [["source", "二次元原图", true], ["identity", "真人质感参考", false], ["material", "服装材质参考", false], ["lighting", "写实光影参考", false]],
        options: [
            ["natural", "自然真人", "重建为自然可信的东亚真人形象，采用符合原角色气质的东方脸型与东亚五官比例、自然黑色或深色发质、真实皮肤纹理、独立发丝、真实布料和克制自然光线，避免欧美化面孔、网红脸与过度磨皮。"],
            ["cinematic", "电影剧照", "转换为由东亚演员呈现的高完成度真人电影剧照，保持东方脸型与东亚五官特征，使用真实镜头质感、电影级布光、自然景深和细腻但不过度锐化的材质细节，避免生成欧美面孔。"],
            ["studio", "真人设定照", "转换为专业东亚真人角色设定摄影，保持自然东方脸型、东亚五官比例与原角色辨识度，人物结构清楚、全身完整、背景干净、光线均匀，便于后续保持角色一致性。"],
        ],
        prompt: "将 <image1> 中的二次元或动漫角色重建为真实人物摄影画面。默认重建为自然可信的东亚人物，采用符合原角色气质的东方脸型、东亚五官比例与自然面部骨相；除非原图明确表现其他族裔，不得擅自转为欧美面孔。严格保持 <image1> 的角色辨识特征、脸型轮廓、发型结构与发色、服装款式与配色、配饰、体型、姿势、表情、构图、镜头角度以及背景空间关系；只把动漫线稿、卡通色块和夸张绘制语言转换为符合真实人体结构的五官、皮肤、发丝、布料、材质、光影与空间细节。如上传补充参考图，仅借鉴其真人质感、材质或光线，不替换原角色的核心身份、东方人物特征与原始设计。",
        negative: "欧美化面孔，西方五官，深眼窝，过高鼻骨，夸张立体骨相，动漫线稿残留，卡通色块，塑料皮肤，蜡像感，网红脸，身份改变，发型改变，发色改变，服装款式改变，配色改变，姿势改变，构图改变，背景改变，五官畸形，肢体畸形，手部错误，过度磨皮，过度锐化",
    },
};

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .xq21-director{box-sizing:border-box;width:100%;min-width:620px;color:#e9edf5;font-family:Inter,"Microsoft YaHei",sans-serif}.xq21-director *{box-sizing:border-box}
        .xq21-shell{display:flex;flex-direction:column;gap:10px;padding:10px;border:1px solid #343c4d;border-radius:10px;background:linear-gradient(180deg,#1d222c,#171b23)}
        .xq21-section{border:1px solid #303848;border-radius:8px;background:#202631;overflow:hidden}.xq21-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;border-bottom:1px solid #303848}
        .xq21-title{display:flex;align-items:center;gap:8px;min-width:0}.xq21-title strong{font-size:13px;color:#f3f6fb}.xq21-title small{color:#8f9bad;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xq21-badge{padding:2px 7px;border-radius:999px;color:#a8d7ff;background:#173a55;font-size:10px;white-space:nowrap}
        .xq21-button,.xq21-task-nav button,.xq21-nav button,.xq21-subnav button,.xq21-options button,.xq21-role-slot{border:1px solid #3b485a;border-radius:6px;color:#cbd5e2;background:#252c38;cursor:pointer}.xq21-button{padding:6px 10px;color:#dceeff;background:#23445e}.xq21-button:hover{background:#2c5878}.xq21-button:disabled{opacity:.45;cursor:default}
        .xq21-task-nav{display:flex;align-items:center;gap:6px}.xq21-task-nav button{padding:7px 13px;font-weight:700}.xq21-task-nav button.active{border-color:#4d9ad0;color:#eaf7ff;background:#23516f}.xq21-edit-navigation[hidden],.xq21-section[hidden]{display:none}
        .xq21-nav-wrap{padding:10px}.xq21-nav,.xq21-subnav,.xq21-options{display:flex;flex-wrap:wrap;gap:6px}.xq21-nav button{padding:7px 12px;font-weight:700}.xq21-nav button.active{border-color:#4d9ad0;color:#eaf7ff;background:#23516f}.xq21-subnav{margin-top:8px;padding-top:8px;border-top:1px solid #303848}.xq21-subnav button{padding:6px 10px;font-size:11px}.xq21-subnav button.active{border-color:#6e91b0;color:#fff;background:#36495d}
        .xq21-options{padding:8px 10px;border-top:1px solid #303848;background:#1b212b}.xq21-options button{padding:5px 9px;font-size:11px}.xq21-options button.active{border-color:#8975cf;color:#f1edff;background:#443a6a}.xq21-options[hidden]{display:none}
        .xq21-top-actions,.xq21-field-actions{display:flex;align-items:center;gap:7px}.xq21-template-action{border:0;padding:2px 3px;color:#72d5aa;background:transparent;cursor:pointer;font-size:10px}
        .xq21-shot-body{display:flex;flex-direction:column;gap:9px;padding:10px}.xq21-shot-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:7px;max-height:260px;overflow-x:hidden;overflow-y:auto;padding-right:4px}.xq21-shot-card{position:relative;min-width:0}.xq21-shot{display:flex;width:100%;min-width:0;flex-direction:column;align-items:flex-start;gap:3px;border:1px solid #3b485a;border-radius:7px;padding:7px 30px 7px 9px;color:#cbd5e2;background:#252c38;cursor:pointer}.xq21-shot.active{border-color:#4d9ad0;color:#f2f9ff;background:#23445e}.xq21-shot b,.xq21-shot small{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xq21-shot b{font-size:11px}.xq21-shot small{color:#8fa0b4;font-size:9px}.xq21-shot.active small{color:#b9d9ef}.xq21-shot-pick{position:absolute;top:7px;right:7px;z-index:2;display:grid;width:17px;height:17px;place-items:center;cursor:pointer}.xq21-shot-pick input{width:14px;height:14px;margin:0;accent-color:#45a578;cursor:pointer}.xq21-shot-controls{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.xq21-shot-actions,.xq21-generate-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.xq21-shot-action{border:1px solid #3b485a;border-radius:6px;padding:6px 9px;color:#cbd5e2;background:#252c38;cursor:pointer;font-size:10px}.xq21-shot-action:hover{border-color:#5b83a5}.xq21-shot-action.primary{border-color:#39795e;color:#eafff4;background:#276047}.xq21-shot-action:disabled{opacity:.45;cursor:default}.xq21-queue-status{min-height:16px;color:#8f9bad;font-size:10px}.xq21-queue-status.error{color:#ff9b9f}
        .xq21-upload{padding:10px}.xq21-role-slots{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-bottom:9px}.xq21-role-slots[hidden]{display:none}.xq21-role-wrap{display:flex;flex-direction:column;gap:4px;min-width:0}.xq21-role-slot{display:flex;flex-direction:column;align-items:flex-start;gap:3px;min-height:50px;padding:7px 8px;text-align:left}.xq21-role-slot b{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.xq21-role-slot small{font-size:9px;color:#8491a3}.xq21-role-slot.required small{color:#efb7a0}.xq21-role-slot.filled{border-color:#39795e;background:#203d33}.xq21-role-slot:hover{border-color:#5b83a5}.xq21-pose-extract{border:1px solid #655794;border-radius:5px;padding:5px;color:#e7e0ff;background:#393253;cursor:pointer;font-size:10px}.xq21-pose-extract:hover{background:#4b416e}
        .xq21-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.xq21-card{position:relative;min-width:0;border:1px solid #394456;border-radius:7px;overflow:hidden;background:#151a21;cursor:pointer}.xq21-card.dragging{opacity:.45}.xq21-thumb{display:block;width:100%;aspect-ratio:1/1;object-fit:contain;background:#0e1117}.xq21-card-foot{display:flex;align-items:center;gap:5px;min-width:0;padding:5px 6px}.xq21-index{flex:0 0 auto;width:19px;height:19px;border-radius:50%;background:#25628d;color:white;text-align:center;line-height:19px;font-size:10px}.xq21-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#bcc6d4;font-size:10px}.xq21-remove{flex:0 0 auto;width:21px;height:21px;padding:0;border:0;border-radius:5px;color:#d7a8aa;background:#3b242a;cursor:pointer}
        .xq21-fields{display:grid;grid-template-columns:1fr 1fr;gap:9px;padding:10px}.xq21-field{display:flex;flex-direction:column;gap:6px;min-width:0}.xq21-field-head{display:flex;align-items:center;justify-content:space-between}.xq21-field label{color:#cbd3df;font-size:12px;font-weight:600}.xq21-reset{border:0;color:#83b7dd;background:transparent;cursor:pointer;font-size:10px}.xq21-field textarea,.xq21-positive-editor{width:100%;min-height:190px;border:1px solid #394456;border-radius:7px;padding:9px;outline:none;color:#e8edf4;background:#131820;font:12px/1.55 Consolas,"Microsoft YaHei",sans-serif}.xq21-field textarea{resize:vertical}.xq21-field textarea:focus,.xq21-positive-editor:focus{border-color:#4f94c7;box-shadow:0 0 0 1px #4f94c766}.xq21-positive-editor{max-height:360px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;caret-color:#fff;user-select:text}.xq21-positive-editor:empty:before{content:attr(data-placeholder);color:#697789;pointer-events:none}.xq21-inline-image{display:inline-flex;max-width:185px;min-height:34px;margin:2px 3px;align-items:center;gap:5px;vertical-align:middle;padding:2px 7px 2px 2px;border:1px solid #3f7698;border-radius:7px;color:#cdeeff;background:#20384a;white-space:nowrap}.xq21-inline-image img{width:30px;height:30px;flex:0 0 30px;object-fit:cover;border-radius:5px;background:#0e1117}.xq21-inline-image b{overflow:hidden;text-overflow:ellipsis;font-size:10px}.xq21-inline-image.unresolved{border-color:#815459;color:#ffb7bc;background:#41272c}.xq21-inline-image.unresolved:before{content:"无图";display:grid;width:30px;height:30px;place-items:center;border-radius:5px;color:#c98f93;background:#26191c;font-size:8px}.xq21-status.error{color:#ff9b9f!important}.xq21-controlled [data-role-slots] button,.xq21-controlled .xq21-remove,.xq21-controlled [data-upload],.xq21-controlled .xq21-task-nav button,.xq21-controlled .xq21-nav button,.xq21-controlled .xq21-subnav button,.xq21-controlled .xq21-options button{pointer-events:none;opacity:.45}.xq21-controlled .xq21-positive-editor,.xq21-controlled [data-negative]{border-color:#3f78a2;background:#101c27;color:#cfeeff}.xq21-controlled .xq21-positive-editor:before{content:"分镜受控";float:right;margin:0 0 5px 8px;padding:2px 6px;border-radius:999px;color:#bfeaff;background:#174b69;font-size:9px}
        .xq21-pose-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:24px;background:#06080db8}.xq21-pose-dialog{width:min(720px,92vw);max-height:92vh;overflow:auto;border:1px solid #48566c;border-radius:12px;color:#e8edf5;background:#1b212b;box-shadow:0 22px 80px #000b}.xq21-pose-head,.xq21-pose-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid #303a4a}.xq21-pose-head button{border:0;color:#ccd5e0;background:transparent;cursor:pointer;font-size:20px}.xq21-pose-body{display:grid;grid-template-columns:230px 1fr;gap:12px;padding:14px}.xq21-pose-controls{display:flex;flex-direction:column;gap:9px}.xq21-pose-controls label{display:flex;flex-direction:column;gap:5px;color:#aeb9c8;font-size:11px}.xq21-pose-controls select,.xq21-pose-controls button{border:1px solid #405067;border-radius:6px;padding:7px;color:#e7edf5;background:#252e3b}.xq21-pose-controls button{cursor:pointer}.xq21-pose-preview{display:flex;align-items:center;justify-content:center;min-height:340px;border:1px dashed #48566c;border-radius:8px;background:#10151c}.xq21-pose-preview img{display:block;max-width:100%;max-height:58vh;object-fit:contain}.xq21-pose-preview span{color:#7f8b9c;font-size:12px}.xq21-pose-message{min-height:32px;color:#92a0b2;font-size:11px;line-height:1.45}.xq21-pose-message.error{color:#ff9b9f}.xq21-pose-actions{justify-content:flex-end;border-top:1px solid #303a4a;border-bottom:0}.xq21-pose-actions button{border:1px solid #405067;border-radius:6px;padding:7px 12px;color:#e8edf5;background:#293342;cursor:pointer}.xq21-pose-actions button.primary{border-color:#39795e;background:#276047}.xq21-pose-actions button:disabled{opacity:.45;cursor:default}
        @media(max-width:720px){.xq21-fields{grid-template-columns:1fr}.xq21-grid,.xq21-role-slots{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
}

function findWidget(node, name) { return (node.widgets || []).find((widget) => widget.name === name); }
function hideWidget(widget) {
    if (!widget || widget.__xq21Hidden) return;
    widget.__xq21Hidden = true; widget.origType ??= widget.type; widget.type = "converted-widget"; widget.hidden = true;
    widget.computeSize = () => [0, -4]; widget.draw = () => {}; widget.mouse = () => false;
    widget.serializeValue = async () => widget.value;
    if (widget.element) widget.element.style.display = "none";
}
function parseAssets(value) {
    try { const parsed = JSON.parse(String(value || "[]")); return Array.isArray(parsed) ? parsed.slice(0, MAX_IMAGES) : []; } catch { return []; }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isTextMode(mode) { return PRESETS[mode]?.task === "text"; }
function getGroup(mode, groups = GROUPS) { return groups.find((group) => group.modes.includes(mode)) || groups[0]; }
function withHandNegative(value) {
    const negative = String(value || "").trim();
    return negative.toLowerCase().includes(HAND_NEGATIVE.toLowerCase()) ? negative : `${negative}${negative ? ", " : ""}${HAND_NEGATIVE}`;
}
function ensureSamplerLatent(prompt, textMode) {
    const output = prompt?.output;
    if (!output || typeof output !== "object") return 0;
    const entries = Object.entries(output);
    const director = entries.find(([, item]) => item?.class_type === NODE_NAME);
    const emptyLatent = entries.find(([, item]) => item?.class_type === "EmptyLatentImage" && String(item?._meta?.title || "").includes("自定义尺寸"))
        || entries.find(([, item]) => item?.class_type === "EmptyLatentImage");
    const source = textMode ? (emptyLatent || director) : director;
    if (!source) return 0;
    const sourceSlot = source === director ? 2 : 0;
    let repaired = 0;
    entries.forEach(([, item]) => {
        if (item?.class_type !== "KSampler" || item.inputs?.latent_image) return;
        item.inputs ??= {};
        item.inputs.latent_image = [String(source[0]), sourceSlot];
        repaired += 1;
    });
    return repaired;
}
function waitForPromptCompletion(promptId) {
    const expectedId = String(promptId || "");
    if (!expectedId) return Promise.reject(new Error("任务编号为空，无法等待生成完成"));
    return new Promise((resolve, reject) => {
        let settled = false;
        let pollTimer = 0;
        const detailOf = (event) => event?.detail && typeof event.detail === "object" ? event.detail : {};
        const matches = (event) => String(detailOf(event).prompt_id || "") === expectedId;
        const cleanup = () => {
            if (pollTimer) clearTimeout(pollTimer);
            api.removeEventListener?.("execution_success", onSuccess);
            api.removeEventListener?.("execution_error", onFailure);
            api.removeEventListener?.("execution_interrupted", onFailure);
        };
        const finish = (error = null) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error); else resolve();
        };
        const onSuccess = (event) => { if (matches(event)) finish(); };
        const onFailure = (event) => {
            if (!matches(event)) return;
            const detail = detailOf(event);
            finish(new Error(detail.exception_message || detail.error || "当前图片生成失败，已停止后续批量任务"));
        };
        const pollHistory = async () => {
            if (settled) return;
            try {
                const response = await api.fetchApi(`/history/${encodeURIComponent(expectedId)}`);
                if (response.ok) {
                    const history = await response.json();
                    const entry = history?.[expectedId] || Object.values(history || {})[0];
                    const status = entry?.status || {};
                    if (status.completed === true || status.status_str === "success") return finish();
                    if (status.status_str === "error") {
                        const message = [...(status.messages || [])].reverse().find((item) => item?.[0] === "execution_error")?.[1]?.exception_message;
                        return finish(new Error(message || "当前图片生成失败，已停止后续批量任务"));
                    }
                }
            } catch {
                // WebSocket events remain the primary completion signal. A
                // temporary history read failure must not duplicate a task.
            }
            pollTimer = window.setTimeout(pollHistory, 1000);
        };
        api.addEventListener("execution_success", onSuccess);
        api.addEventListener("execution_error", onFailure);
        api.addEventListener("execution_interrupted", onFailure);
        pollTimer = window.setTimeout(pollHistory, 1000);
    });
}
function optionFor(preset, optionId) { return (preset.options || []).find((option) => option[0] === optionId) || preset.options?.[0]; }
function assignedReferencePrompt(preset, assets = []) {
    if (preset.group === "free") return "";
    const slots = new Map(preset.slots.map((slot) => [slot[0], slot]));
    const references = [];
    assets.forEach((asset, index) => {
        const slot = slots.get(asset.slotKey);
        if (slot) references.push(`<image${index + 1}> 是“${slot[1]}”`);
    });
    if (!references.length) return "";
    return `参考图职责：${references.join("；")}。严格按照以上职责使用参考图，不得混淆各图片的身份、内容和用途。`;
}
function templateFor(preset, optionId, assets = []) {
    const option = optionFor(preset, optionId);
    return [preset.prompt, option?.[2] || "", assignedReferencePrompt(preset, assets)].filter(Boolean).join(" ");
}
function migrateLegacyPromptLabels(value) {
    const replacements = [
        ["是“版式构图”", "是“广告排版参考”"],
        ["是“位置构图参考”", "是“物体摆放位置”"],
        ["是“字体版式参考”", "是“文字样式参考”"],
        ["是“构图姿势参考”", "是“人物站位与动作”"],
    ];
    return replacements.reduce((text, [before, after]) => text.replaceAll(before, after), String(value || ""));
}
function roleLabel(preset, asset, index) {
    if (preset.group === "free") return `自由参考 ${index + 1}`;
    const slot = preset.slots.find((item) => item[0] === asset.slotKey);
    return slot?.[1] || `补充参考 ${index + 1}`;
}
function previewUrl(asset) {
    return api.apiURL(`/view?${new URLSearchParams({ filename: String(asset.name || asset.filename || ""), type: String(asset.type || "input"), subfolder: String(asset.subfolder || "") }).toString()}`);
}
async function uploadImage(file) {
    const body = new FormData(); body.append("image", file, file.name); body.append("type", "input"); body.append("subfolder", "xiantu_qwen_image21"); body.append("overwrite", "false");
    const response = await api.fetchApi("/upload/image", { method: "POST", body });
    let result = {}; try { result = await response.json(); } catch {}
    if (!response.ok || !result.name) throw new Error(result.error || `图片上传失败（HTTP ${response.status}）`);
    return { name: String(result.name), subfolder: String(result.subfolder || ""), type: "input", displayName: String(file.name || result.name) };
}

function createDirectorUi(node) {
    ensureStyles();
    const promptWidget = findWidget(node, "positive_prompt");
    const negativeWidget = findWidget(node, "negative_prompt");
    const resolutionWidget = findWidget(node, "resolution");
    const assetsWidget = findWidget(node, "reference_images");
    [promptWidget, negativeWidget, resolutionWidget, assetsWidget].forEach(hideWidget);

    const root = document.createElement("div");
    root.className = "xq21-director";
    root.tabIndex = 0;
    root.innerHTML = `
      <div class="xq21-shell">
        <section class="xq21-section" data-manual-image-manager><div class="xq21-head"><div class="xq21-title"><strong>图片管理</strong><small>每张图片独立保存功能、参考图和提示词</small><span class="xq21-badge" data-shot-count>1 张图片</span></div></div><div class="xq21-shot-body"><div class="xq21-shot-list" data-shot-list></div><div class="xq21-shot-controls"><div class="xq21-shot-actions"><button type="button" class="xq21-shot-action" data-shot-add>＋ 图片</button><button type="button" class="xq21-shot-action" data-shot-clear>清空图片</button><button type="button" class="xq21-shot-action" data-shot-left>← 前移</button><button type="button" class="xq21-shot-action" data-shot-right>后移 →</button><button type="button" class="xq21-shot-action" data-shot-delete>删除</button></div><div class="xq21-generate-actions"><button type="button" class="xq21-shot-action primary" data-generate-current>生成当前图片</button><button type="button" class="xq21-shot-action primary" data-generate-all>从当前图片批量生成</button></div></div><div class="xq21-queue-status" data-queue-status>等待生成</div></div></section>
        <section class="xq21-section"><div class="xq21-head"><div class="xq21-task-nav" data-task-nav><button type="button" data-task="text">文生图</button><button type="button" data-task="edit">图片编辑</button></div><div class="xq21-title"><small data-mode-description></small><span class="xq21-badge">QWEN 2.1</span></div></div><div class="xq21-edit-navigation" data-edit-navigation><div class="xq21-nav-wrap"><div class="xq21-nav" data-nav></div><div class="xq21-subnav" data-subnav></div></div><div class="xq21-options" data-options hidden></div></div></section>
        <section class="xq21-section" data-reference-section><div class="xq21-head"><div class="xq21-title"><strong>对应参考图</strong><small class="xq21-status" data-status>按槽位上传，顺序自动对应 &lt;image1&gt;…</small><span class="xq21-badge" data-count>0 / 16</span></div><button type="button" class="xq21-button" data-upload>＋ 添加图片</button></div><div class="xq21-upload"><div class="xq21-role-slots" data-role-slots></div><div class="xq21-grid" data-grid hidden></div><input type="file" accept="image/*" multiple data-file hidden></div></section>
        <section class="xq21-section"><div class="xq21-fields"><div class="xq21-field"><div class="xq21-field-head"><label>正向提示词</label><div class="xq21-field-actions"><button type="button" class="xq21-template-action" data-apply-template>应用提示词参考</button><button type="button" class="xq21-reset" data-reset-positive>恢复当前功能模板</button></div></div><div class="xq21-positive-editor" contenteditable="true" data-positive-editor data-placeholder="描述要生成或修改的画面；点击上方图片可插入引用"></div><textarea data-positive hidden></textarea></div><div class="xq21-field"><div class="xq21-field-head"><label>负向提示词</label><button type="button" class="xq21-reset" data-reset-negative>恢复模板</button></div><textarea data-negative></textarea></div></div></section>
      </div>`;

    const nav = root.querySelector("[data-nav]"), subnav = root.querySelector("[data-subnav]"), options = root.querySelector("[data-options]");
    const manualImageManager = root.querySelector("[data-manual-image-manager]"), taskNav = root.querySelector("[data-task-nav]"), editNavigation = root.querySelector("[data-edit-navigation]"), referenceSection = root.querySelector("[data-reference-section]");
    const controlledQueue = document.createElement("section");
    controlledQueue.className = "xq21-section xq21-controlled-queue";
    controlledQueue.hidden = true;
    controlledQueue.innerHTML = `<div class="xq21-head"><div class="xq21-title"><strong>分镜资产任务</strong><small>由故事分镜导演台提供；按镜头和槽位自动建立批量图片</small></div></div><div class="xq21-shot-list" data-controlled-task-list></div>`;
    referenceSection.before(controlledQueue);
    const modeDescription = root.querySelector("[data-mode-description]"), roleSlots = root.querySelector("[data-role-slots]");
    const fileInput = root.querySelector("[data-file]"), uploadButton = root.querySelector("[data-upload]");
    const grid = root.querySelector("[data-grid]"), count = root.querySelector("[data-count]"), status = root.querySelector("[data-status]");
    const positive = root.querySelector("[data-positive]"), positiveEditor = root.querySelector("[data-positive-editor]"), negative = root.querySelector("[data-negative]");
    const applyTemplateButton = root.querySelector("[data-apply-template]");
    const shotList = root.querySelector("[data-shot-list]"), shotCount = root.querySelector("[data-shot-count]"), queueStatus = root.querySelector("[data-queue-status]");
    const generateCurrentButton = root.querySelector("[data-generate-current]"), generateAllButton = root.querySelector("[data-generate-all]");
    let busy = false, pendingRole = null, draggedIndex = -1, controlledTask = null;
    let workbench = null, activeMode = "free_edit", assets = [];
    let storyboard = null, activeShotId = "", queueBusy = false;
    let positiveRange = null;

    const markDirty = () => { node.graph?.setDirtyCanvas(true, true); node.setDirtyCanvas?.(true, true); };
    const setStatus = (message, error = false) => { status.textContent = message; status.classList.toggle("error", error); };
    const scheduleSize = () => requestAnimationFrame(() => {
        const width = Math.max(660, Number(node.size?.[0] || 660));
        const height = Math.max(690, Math.ceil(root.scrollHeight + 135));
        if (!node.size || Math.abs(node.size[0] - width) > 1 || Math.abs(node.size[1] - height) > 3) node.setSize?.([width, height]);
    });
    const newState = (mode, seed = {}) => {
        const preset = PRESETS[mode], option = preset.options?.[0]?.[0] || "";
        const seedAssets = clone(seed.assets || []);
        return { assets: seedAssets, positive: String(seed.positive || templateFor(preset, option, seedAssets)), negative: withHandNegative(seed.negative || preset.negative), option };
    };
    const normalizeWorkbench = () => {
        const stored = node.properties?.xiantuQwen21Workbench;
        if (stored && stored.version === 1 && PRESETS[stored.activeMode] && stored.states && typeof stored.states === "object") return clone(stored);
        return { version: 1, activeMode: "free_edit", states: { free_edit: newState("free_edit", { assets: parseAssets(assetsWidget?.value || JSON.stringify(node.properties?.xiantuQwen21Assets || [])), positive: promptWidget?.value, negative: negativeWidget?.value }) } };
    };
    const makeShotId = () => globalThis.crypto?.randomUUID?.() || `shot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const makeShot = (shotWorkbench, title = "") => ({ id: makeShotId(), title, batchSelected: false, workbench: clone(shotWorkbench) });
    const normalizeStoryboard = (initialWorkbench) => {
        const stored = node.properties?.xiantuQwen21Storyboard;
        if (stored?.version === 1 && Array.isArray(stored.shots) && stored.shots.length) {
            const shots = stored.shots.map((shot) => ({ id: String(shot.id || makeShotId()), title: String(shot.title || ""), batchSelected: Boolean(shot.batchSelected), workbench: shot.workbench?.states ? clone(shot.workbench) : clone(initialWorkbench) }));
            const selectedId = shots.some((shot) => shot.id === stored.activeShotId) ? stored.activeShotId : shots[0].id;
            return { version: 1, activeShotId: selectedId, shots };
        }
        const first = makeShot(initialWorkbench);
        return { version: 1, activeShotId: first.id, shots: [first] };
    };
    const activeShot = () => storyboard?.shots.find((shot) => shot.id === activeShotId);
    const shotLabel = (index) => `图片 ${String(index + 1).padStart(2, "0")}`;
    const sortAssets = (preset) => {
        const order = new Map(preset.slots.map((slot, index) => [slot[0], index]));
        assets.sort((a, b) => (order.get(a.slotKey) ?? 1000) - (order.get(b.slotKey) ?? 1000));
    };
    const syncBackendWidgets = () => {
        sortAssets(PRESETS[activeMode]);
        if (assetsWidget) assetsWidget.value = JSON.stringify(assets);
        if (promptWidget) promptWidget.value = positive.value;
        if (negativeWidget) negativeWidget.value = negative.value;
        if (resolutionWidget) resolutionWidget.value = 1024;
    };
    const persist = () => {
        const current = workbench.states[activeMode] || {};
        workbench.states[activeMode] = { assets: clone(assets), positive: positive.value, negative: negative.value, option: current.option || "" };
        workbench.activeMode = activeMode;
        if (isTextMode(activeMode)) workbench.lastTextMode = activeMode;
        else workbench.lastEditMode = activeMode;
        const shot = activeShot(); if (shot) shot.workbench = clone(workbench);
        if (storyboard) storyboard.activeShotId = activeShotId;
        node.properties ??= {}; node.properties.xiantuQwen21Workbench = clone(workbench); node.properties.xiantuQwen21Storyboard = clone(storyboard); node.properties.xiantuQwen21Assets = clone(assets);
        syncBackendWidgets(); markDirty();
    };
    const makeImageReference = (token, index) => {
        const asset = assets[index];
        const reference = document.createElement("span");
        reference.className = `xq21-inline-image${asset ? "" : " unresolved"}`;
        reference.contentEditable = "false";
        reference.dataset.token = token;
        reference.title = asset ? `${token} · ${roleLabel(PRESETS[activeMode], asset, index)} · ${asset.displayName || asset.name || "参考图"}` : `${token} · 尚未上传对应图片`;
        if (asset) {
            const image = document.createElement("img");
            image.src = previewUrl(asset);
            image.alt = "";
            image.draggable = false;
            reference.appendChild(image);
        }
        const label = document.createElement("b");
        label.textContent = token;
        reference.appendChild(label);
        return reference;
    };
    const renderPositiveEditor = () => {
        const prompt = String(positive.value || "");
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        for (const match of prompt.matchAll(/<image(\d+)>/gi)) {
            const offset = Number(match.index || 0);
            if (offset > cursor) fragment.appendChild(document.createTextNode(prompt.slice(cursor, offset)));
            fragment.appendChild(makeImageReference(match[0], Number(match[1]) - 1));
            cursor = offset + match[0].length;
        }
        if (cursor < prompt.length) fragment.appendChild(document.createTextNode(prompt.slice(cursor)));
        positiveEditor.replaceChildren(fragment);
        positiveRange = null;
    };
    const syncPositiveText = () => {
        positive.value = String(positiveEditor.innerText || "").replace(/\r/g, "").replace(/\u00a0/g, " ");
    };
    const rememberPositiveRange = () => {
        const selection = window.getSelection();
        if (selection?.rangeCount && positiveEditor.contains(selection.anchorNode)) positiveRange = selection.getRangeAt(0).cloneRange();
    };
    const insertImageReference = (index) => {
        const token = `<image${index + 1}>`;
        positiveEditor.focus();
        const selection = window.getSelection();
        const range = positiveRange && positiveEditor.contains(positiveRange.commonAncestorContainer) ? positiveRange.cloneRange() : document.createRange();
        if (!positiveRange || !positiveEditor.contains(range.commonAncestorContainer)) { range.selectNodeContents(positiveEditor); range.collapse(false); }
        range.deleteContents();
        const before = document.createTextNode(positiveEditor.textContent ? " " : "");
        const reference = makeImageReference(token, index);
        const after = document.createTextNode(" ");
        const fragment = document.createDocumentFragment();
        fragment.append(before, reference, after);
        range.insertNode(fragment);
        range.setStartAfter(after); range.collapse(true);
        selection.removeAllRanges(); selection.addRange(range); positiveRange = range.cloneRange();
        syncPositiveText();
        persist();
        setStatus(`已插入 ${token} · ${roleLabel(PRESETS[activeMode], assets[index], index)}`);
    };

    const renderNavigation = () => {
        const preset = PRESETS[activeMode], textMode = isTextMode(activeMode); modeDescription.textContent = preset.description;
        taskNav.querySelectorAll("button").forEach((button) => button.classList.toggle("active", button.dataset.task === (textMode ? "text" : "edit")));
        editNavigation.hidden = false; referenceSection.hidden = textMode;
        nav.replaceChildren();
        const groups = textMode ? T2I_GROUPS : GROUPS;
        const group = getGroup(activeMode, groups);
        groups.forEach((item) => { const button = document.createElement("button"); button.type = "button"; button.textContent = item.label; button.disabled = Boolean(controlledTask); button.classList.toggle("active", item.id === group.id); button.onclick = () => { if (!controlledTask) switchMode(item.modes[0]); }; nav.appendChild(button); });
        subnav.replaceChildren();
        group.modes.forEach((mode) => { const button = document.createElement("button"); button.type = "button"; button.textContent = PRESETS[mode].label; button.disabled = Boolean(controlledTask); button.classList.toggle("active", mode === activeMode); button.onclick = () => { if (!controlledTask) switchMode(mode); }; subnav.appendChild(button); });
        applyTemplateButton.textContent = textMode ? "应用官方提示词参考" : "应用提示词参考";
        options.replaceChildren(); const state = workbench.states[activeMode];
        options.hidden = !(preset.options || []).length;
        (preset.options || []).forEach((option) => { const button = document.createElement("button"); button.type = "button"; button.textContent = option[1]; button.classList.toggle("active", option[0] === state.option); button.onclick = () => { state.option = option[0]; positive.value = templateFor(preset, option[0], assets); renderPositiveEditor(); persist(); renderNavigation(); }; options.appendChild(button); });
    };

    const applyPromptTemplate = () => {
        const preset = PRESETS[activeMode];
        const state = workbench.states[activeMode];
        sortAssets(preset);
        positive.value = templateFor(preset, state.option, assets);
        renderPositiveEditor(); persist();
        const assignedCount = assets.filter((asset) => preset.slots.some((slot) => slot[0] === asset.slotKey)).length;
        setStatus(isTextMode(activeMode) ? `已应用“${preset.label}”官方结构参考；请替换【】内内容。` : (preset.group === "free" ? "已恢复自由编辑提示词；自由参考图请按需要手动插入。" : `已应用“${preset.label}”提示词参考，并写入 ${assignedCount} 张槽位参考图。`));
    };

    const renderRoleSlots = () => {
        const preset = PRESETS[activeMode]; roleSlots.replaceChildren(); roleSlots.hidden = activeMode === "free_edit";
        if (roleSlots.hidden) return;
        preset.slots.forEach((slot, index) => {
            const asset = assets.find((item) => item.slotKey === slot[0]);
            const wrap = document.createElement("div"); wrap.className = "xq21-role-wrap";
            const button = document.createElement("button"); button.type = "button"; button.className = `xq21-role-slot${slot[2] ? " required" : ""}${asset ? " filled" : ""}`;
            const title = document.createElement("b"); title.textContent = `${index + 1}. ${slot[1]}`;
            const hint = document.createElement("small"); hint.textContent = asset ? `已上传 · 点击替换` : (slot[2] ? "必传 · 点击上传" : "可选 · 点击上传");
            button.append(title, hint); button.onclick = () => { const previousRequiredMissing = preset.slots.slice(0, index).find((item) => item[2] && !assets.some((assetItem) => assetItem.slotKey === item[0])); if (previousRequiredMissing) return setStatus(`请先上传：${previousRequiredMissing[1]}`, true); pendingRole = slot[0]; fileInput.click(); };
            wrap.appendChild(button);
            if (slot[0] === "pose") { const extract = document.createElement("button"); extract.type = "button"; extract.className = "xq21-pose-extract"; extract.textContent = "提取姿势"; extract.onclick = () => openPoseExtractor(slot[0]); wrap.appendChild(extract); }
            roleSlots.appendChild(wrap);
        });
    };

    const renderAssets = () => {
        const preset = PRESETS[activeMode]; sortAssets(preset); count.textContent = `${assets.length} / ${MAX_IMAGES}`; uploadButton.disabled = busy || assets.length >= MAX_IMAGES;
        grid.hidden = assets.length === 0; grid.replaceChildren();
        assets.forEach((asset, index) => {
            const card = document.createElement("div"); card.className = "xq21-card"; card.draggable = activeMode === "free_edit"; card.title = String(asset.displayName || asset.name || "参考图");
            const image = document.createElement("img"); image.className = "xq21-thumb"; image.src = previewUrl(asset); image.alt = `参考图 ${index + 1}`;
            const foot = document.createElement("div"); foot.className = "xq21-card-foot";
            const badge = document.createElement("span"); badge.className = "xq21-index"; badge.textContent = String(index + 1);
            const name = document.createElement("span"); name.className = "xq21-name"; name.textContent = `<image${index + 1}> · ${roleLabel(preset, asset, index)}`; name.title = String(asset.displayName || asset.name || "参考图");
            const remove = document.createElement("button"); remove.type = "button"; remove.className = "xq21-remove"; remove.textContent = "×"; remove.title = "移除"; remove.onclick = (event) => { event.stopPropagation(); const managedTemplate = positive.value === templateFor(preset, workbench.states[activeMode].option, assets); assets.splice(index, 1); if (managedTemplate) positive.value = templateFor(preset, workbench.states[activeMode].option, assets); persist(); renderAll(); };
            card.onclick = (event) => { if (!event.target.closest("button")) insertImageReference(index); };
            if (activeMode === "free_edit") {
                card.ondragstart = () => { draggedIndex = index; card.classList.add("dragging"); };
                card.ondragend = () => { draggedIndex = -1; card.classList.remove("dragging"); };
                card.ondragover = (event) => event.preventDefault();
                card.ondrop = (event) => { event.preventDefault(); event.stopPropagation(); if (draggedIndex < 0 || draggedIndex === index) return; const [moved] = assets.splice(draggedIndex, 1); assets.splice(index, 0, moved); assets.forEach((item, position) => { item.slotKey = preset.slots[position]?.[0] || `extra_${position}`; }); draggedIndex = -1; persist(); renderAll(); };
            }
            foot.append(badge, name, remove); card.append(image, foot); grid.appendChild(card);
        });
        renderRoleSlots(); renderPositiveEditor(); scheduleSize();
    };

    const renderShots = () => {
        const previousScrollTop = shotList.scrollTop;
        shotList.replaceChildren();
        storyboard.shots.forEach((shot, index) => {
            const card = document.createElement("div"); card.className = "xq21-shot-card";
            const button = document.createElement("button"); button.type = "button"; button.className = "xq21-shot"; button.classList.toggle("active", shot.id === activeShotId);
            const title = document.createElement("b"); title.textContent = shot.title || shotLabel(index);
            const mode = shot.workbench?.activeMode; const detail = document.createElement("small"); detail.textContent = PRESETS[mode]?.label || "自由编辑";
            const pick = document.createElement("label"); pick.className = "xq21-shot-pick"; pick.title = "勾选后只批量生成已勾选图片";
            const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = Boolean(shot.batchSelected); checkbox.setAttribute("aria-label", `${shot.title || shotLabel(index)}加入批量生成`);
            checkbox.onclick = (event) => event.stopPropagation(); checkbox.onchange = () => { shot.batchSelected = checkbox.checked; persist(); renderShots(); };
            pick.appendChild(checkbox); button.append(title, detail); button.onclick = () => switchShot(shot.id); card.append(button, pick); shotList.appendChild(card);
        });
        const index = storyboard.shots.findIndex((shot) => shot.id === activeShotId);
        const selectedCount = storyboard.shots.filter((shot) => shot.batchSelected).length;
        shotCount.textContent = `${storyboard.shots.length} 张图片`;
        generateAllButton.textContent = selectedCount ? `生成已勾选图片（${selectedCount}）` : "从当前图片批量生成";
        root.querySelector("[data-shot-left]").disabled = queueBusy || index <= 0;
        root.querySelector("[data-shot-right]").disabled = queueBusy || index < 0 || index >= storyboard.shots.length - 1;
        root.querySelector("[data-shot-delete]").disabled = queueBusy || storyboard.shots.length <= 1;
        root.querySelector("[data-shot-add]").disabled = queueBusy;
        root.querySelector("[data-shot-clear]").disabled = queueBusy;
        generateCurrentButton.disabled = queueBusy;
        generateAllButton.disabled = queueBusy;
        requestAnimationFrame(() => { shotList.scrollTop = previousScrollTop; });
    };
    const syncControlledMode = () => {
        controlledTask = linkedStoryboardTask(node);
        root.classList.toggle("xq21-controlled", Boolean(controlledTask));
        manualImageManager.hidden = Boolean(controlledTask);
        taskNav.querySelectorAll("button").forEach((button) => { button.disabled = Boolean(controlledTask); });
        positiveEditor.contentEditable = controlledTask ? "false" : "true";
        negative.disabled = Boolean(controlledTask);
        fileInput.disabled = Boolean(controlledTask);
        applyTemplateButton.disabled = Boolean(controlledTask);
        root.querySelector("[data-reset-positive]").disabled = Boolean(controlledTask);
        root.querySelector("[data-reset-negative]").disabled = Boolean(controlledTask);
        controlledQueue.hidden = !controlledTask;
        const taskList = controlledQueue.querySelector("[data-controlled-task-list]");
        taskList.replaceChildren();
        if (!controlledTask) return;
        const controlledMode = String(controlledTask.generationMode || "").includes("文生图") ? "text_to_image" : "free_edit";
        activeMode = controlledMode;
        workbench.activeMode = controlledMode;
        workbench.states[controlledMode] ||= newState(controlledMode);
        (controlledTask.jobs || []).forEach((job) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "xq21-shot";
            button.classList.toggle("active", job.taskId === controlledTask.taskId);
            button.innerHTML = `<b>${job.shotTitle} · ${job.label}</b><small>${job.generationMode} · ${job.promptEngine}</small>`;
            button.onclick = () => {
                const sourceState = controlledTask.sourceState;
                if (String(job.taskId || "").startsWith("asset:")) {
                    sourceState.active_asset_task_id = String(job.taskId).slice(6);
                    controlledTask.source.properties.xiantuStoryboardDirector = clone(sourceState);
                    const data = findWidget(controlledTask.source, "storyboard_json");
                    if (data) data.value = JSON.stringify(sourceState);
                    controlledTask.source.setDirtyCanvas?.(true, true);
                    requestAnimationFrame(() => renderAll());
                    return;
                }
                const sourceShot = sourceState.shots.find((item) => item.id === job.shotId);
                if (!sourceShot) return;
                sourceState.active_shot_id = job.shotId;
                sourceShot.active_image_task_id = job.taskId;
                controlledTask.source.properties.xiantuStoryboardDirector = clone(sourceState);
                const data = findWidget(controlledTask.source, "storyboard_json");
                const active = findWidget(controlledTask.source, "active_shot_id");
                if (data) data.value = JSON.stringify(sourceState);
                if (active) active.value = job.shotId;
                controlledTask.source.setDirtyCanvas?.(true, true);
                requestAnimationFrame(() => renderAll());
            };
            taskList.appendChild(button);
        });
        positive.value = controlledTask.prompt;
        negative.value = withHandNegative(controlledTask.negative);
        assets = clone(controlledTask.assets || []);
        if (promptWidget) promptWidget.value = positive.value;
        if (negativeWidget) negativeWidget.value = negative.value;
        if (assetsWidget) assetsWidget.value = JSON.stringify(assets);
        setStatus(`受控任务：${controlledTask.label}；提示词与图片由分镜自动提供`);
    };
    const renderAll = () => { syncControlledMode(); renderShots(); renderNavigation(); renderAssets(); uploadButton.disabled = Boolean(controlledTask) || uploadButton.disabled; renderPositiveEditor(); };
    const loadMode = (mode) => {
        activeMode = mode; workbench.activeMode = mode; workbench.states[mode] ||= newState(mode);
        const state = workbench.states[mode]; assets = clone(state.assets || []); sortAssets(PRESETS[mode]); positive.value = migrateLegacyPromptLabels(state.positive || templateFor(PRESETS[mode], state.option, assets)); state.positive = positive.value; negative.value = withHandNegative(state.negative || PRESETS[mode].negative); state.negative = negative.value;
        syncBackendWidgets(); renderAll(); setStatus("点击图片可把缩略图引用插入正向提示词");
    };
    const switchMode = (mode) => { if (controlledTask || mode === activeMode) return; persist(); loadMode(mode); persist(); renderShots(); };
    const switchTask = (task) => switchMode(task === "text" ? (isTextMode(workbench.lastTextMode) ? workbench.lastTextMode : "text_to_image") : (PRESETS[workbench.lastEditMode] && !isTextMode(workbench.lastEditMode) ? workbench.lastEditMode : "free_edit"));
    const switchShot = (shotId) => {
        if (shotId === activeShotId || queueBusy) return;
        persist();
        const shot = storyboard.shots.find((item) => item.id === shotId); if (!shot) return;
        activeShotId = shot.id; storyboard.activeShotId = shot.id; workbench = clone(shot.workbench); loadMode(workbench.activeMode); persist();
    };
    const createBlankWorkbench = (mode = "free_edit") => ({ version: 1, activeMode: mode, lastTextMode: isTextMode(mode) ? mode : undefined, lastEditMode: isTextMode(mode) ? undefined : mode, states: { [mode]: newState(mode) } });
    const addShot = (copyCurrent = false) => {
        if (queueBusy) return;
        persist(); const currentIndex = storyboard.shots.findIndex((shot) => shot.id === activeShotId);
        const shot = makeShot(copyCurrent ? workbench : createBlankWorkbench(activeMode));
        storyboard.shots.splice(Math.max(0, currentIndex + 1), 0, shot); activeShotId = shot.id; storyboard.activeShotId = shot.id; workbench = clone(shot.workbench); loadMode(workbench.activeMode); persist();
    };
    const moveShot = (direction) => {
        if (queueBusy) return;
        persist(); const index = storyboard.shots.findIndex((shot) => shot.id === activeShotId); const next = index + direction;
        if (index < 0 || next < 0 || next >= storyboard.shots.length) return;
        const [shot] = storyboard.shots.splice(index, 1); storyboard.shots.splice(next, 0, shot); persist(); renderShots();
    };
    const deleteShot = () => {
        if (queueBusy || storyboard.shots.length <= 1) return;
        persist(); const index = storyboard.shots.findIndex((shot) => shot.id === activeShotId); storyboard.shots.splice(index, 1);
        const next = storyboard.shots[Math.min(index, storyboard.shots.length - 1)]; activeShotId = next.id; storyboard.activeShotId = next.id; workbench = clone(next.workbench); loadMode(workbench.activeMode); persist();
    };
    const clearShots = () => {
        if (queueBusy) return;
        const first = makeShot(createBlankWorkbench());
        storyboard = { version: 1, activeShotId: first.id, shots: [first] };
        activeShotId = first.id; workbench = clone(first.workbench); loadMode(workbench.activeMode); persist();
        setQueueStatus("已清空全部图片，并重新建立图片 01。");
    };
    const setQueueStatus = (message, error = false) => { queueStatus.textContent = message; queueStatus.classList.toggle("error", error); };
    const queueShots = async (shots) => {
        if (queueBusy || !shots.length) return;
        persist(); const originalShotId = activeShotId; queueBusy = true; renderShots();
        try {
            for (let index = 0; index < shots.length; index += 1) {
                const shot = storyboard.shots.find((item) => item.id === shots[index].id); if (!shot) continue;
                activeShotId = shot.id; storyboard.activeShotId = shot.id; workbench = clone(shot.workbench); loadMode(workbench.activeMode); persist();
                setQueueStatus(`正在提交 ${shotLabel(storyboard.shots.indexOf(shot))}（${index + 1}/${shots.length}）…`);
                await new Promise((resolve) => requestAnimationFrame(resolve));
                const prompt = await app.graphToPrompt();
                ensureSamplerLatent(prompt, isTextMode(activeMode));
                const result = await api.queuePrompt(0, prompt);
                if (!result?.prompt_id) throw new Error(`${shotLabel(storyboard.shots.indexOf(shot))} 没有返回任务编号`);
                setQueueStatus(`正在生成 ${shotLabel(storyboard.shots.indexOf(shot))}（${index + 1}/${shots.length}），完成后自动继续下一张…`);
                await waitForPromptCompletion(result.prompt_id);
            }
            setQueueStatus(`已按顺序完成 ${shots.length} 张图片。`);
        } catch (error) {
            setQueueStatus(`提交失败：${String(error?.message || error)}`, true);
        } finally {
            const original = storyboard.shots.find((shot) => shot.id === originalShotId) || storyboard.shots[0];
            activeShotId = original.id; storyboard.activeShotId = original.id; workbench = clone(original.workbench); loadMode(workbench.activeMode); persist(); queueBusy = false; renderShots();
        }
    };

    const nextSlotKey = (preset) => preset.slots.find((slot) => !assets.some((asset) => asset.slotKey === slot[0]))?.[0] || `extra_${Date.now()}_${assets.length}`;
    const addFiles = async (fileList) => {
        if (controlledTask) return setStatus("已接入资产分镜，参考图由分镜任务自动提供。断开连线后可手动上传。", true);
        const files = [...(fileList || [])].filter((file) => file?.type?.startsWith("image/")); const available = Math.max(0, MAX_IMAGES - assets.length + (pendingRole && assets.some((item) => item.slotKey === pendingRole) ? 1 : 0));
        if (!files.length || !available || busy) return; const selected = files.slice(0, available), preset = PRESETS[activeMode]; const managedTemplate = positive.value === templateFor(preset, workbench.states[activeMode].option, assets); busy = true; renderAssets();
        try {
            for (let index = 0; index < selected.length; index += 1) {
                setStatus(`正在上传 ${index + 1} / ${selected.length}…`); const uploaded = await uploadImage(selected[index]); const slotKey = index === 0 && pendingRole ? pendingRole : nextSlotKey(preset); uploaded.slotKey = slotKey;
                const replaceIndex = assets.findIndex((item) => item.slotKey === slotKey); if (replaceIndex >= 0) assets.splice(replaceIndex, 1, uploaded); else assets.push(uploaded); persist(); renderAssets();
            }
            if (managedTemplate) positive.value = templateFor(preset, workbench.states[activeMode].option, assets);
            persist(); setStatus(`已载入 ${assets.length} 张参考图`);
        } catch (error) { setStatus(String(error?.message || error), true); }
        finally { busy = false; pendingRole = null; fileInput.value = ""; renderAssets(); }
    };

    const openPoseExtractor = (slotKey) => {
        const overlay = document.createElement("div"); overlay.className = "xq21-pose-overlay";
        overlay.innerHTML = `<div class="xq21-pose-dialog"><div class="xq21-pose-head"><strong>闲兔姿势提取</strong><button type="button" data-close>×</button></div><div class="xq21-pose-body"><div class="xq21-pose-controls"><label>来源图片<select data-source></select></label><button type="button" data-upload-source>上传动作照片</button><input type="file" accept="image/*" data-source-file hidden><label>检测范围<select data-detail><option value="body_hand">身体＋手部</option><option value="body">仅身体</option><option value="full">身体＋手部＋面部</option></select></label><label>提取分辨率<select data-pose-resolution><option value="512">512</option><option value="768" selected>768</option><option value="1024">1024</option></select></label><button type="button" data-extract>开始提取</button><div class="xq21-pose-message" data-message>选择来源后开始提取；结果会保存到 output/xiantu_pose_extractions。</div></div><div class="xq21-pose-preview" data-preview><span>等待提取姿势图</span></div></div><div class="xq21-pose-actions"><button type="button" data-cancel>取消</button><button type="button" class="primary" data-use disabled>使用此姿势</button></div></div>`;
        document.body.appendChild(overlay);
        const sourceSelect = overlay.querySelector("[data-source]"), sourceFile = overlay.querySelector("[data-source-file]");
        const message = overlay.querySelector("[data-message]"), preview = overlay.querySelector("[data-preview]"), useButton = overlay.querySelector("[data-use]"), extractButton = overlay.querySelector("[data-extract]");
        const sources = assets.filter((item) => item.slotKey !== slotKey).map((item, index) => ({ asset: item, label: `<image${assets.indexOf(item) + 1}> · ${roleLabel(PRESETS[activeMode], item, index)}` }));
        let extracted = null;
        const renderSources = () => { sourceSelect.replaceChildren(); sources.forEach((source, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = source.label; sourceSelect.appendChild(option); }); if (!sources.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "请上传动作照片"; sourceSelect.appendChild(option); } };
        const close = () => overlay.remove();
        const setMessage = (text, error = false) => { message.textContent = text; message.classList.toggle("error", error); };
        renderSources();
        overlay.querySelector("[data-close]").onclick = close; overlay.querySelector("[data-cancel]").onclick = close;
        overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
        overlay.querySelector("[data-upload-source]").onclick = () => sourceFile.click();
        sourceFile.onchange = async () => { const file = sourceFile.files?.[0]; if (!file) return; try { setMessage("正在上传动作照片…"); const asset = await uploadImage(file); sources.push({ asset, label: `动作照片 · ${file.name}` }); renderSources(); sourceSelect.value = String(sources.length - 1); setMessage("动作照片已上传，可以开始提取。"); } catch (error) { setMessage(String(error?.message || error), true); } };
        extractButton.onclick = async () => {
            const selected = sources[Number(sourceSelect.value)]; if (!selected) return setMessage("请先选择或上传动作照片。", true);
            extractButton.disabled = true; useButton.disabled = true; extracted = null; setMessage("正在运行 DWPose，首次使用可能需要准备模型…");
            try {
                const response = await api.fetchApi("/xiantu/qwen21/pose/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: selected.asset, detail: overlay.querySelector("[data-detail]").value, resolution: Number(overlay.querySelector("[data-pose-resolution]").value) }) });
                const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error || `姿势提取失败（HTTP ${response.status}）`);
                extracted = result.image; const image = document.createElement("img"); image.src = previewUrl(extracted); image.alt = "提取的姿势图"; preview.replaceChildren(image); useButton.disabled = false; setMessage(`提取完成：output/${extracted.subfolder}/${extracted.filename}`);
            } catch (error) { preview.innerHTML = "<span>姿势提取失败</span>"; setMessage(String(error?.message || error), true); }
            finally { extractButton.disabled = false; }
        };
        useButton.onclick = async () => {
            if (!extracted) return; useButton.disabled = true; setMessage("正在把姿势图放入对应槽位…");
            try {
                const response = await fetch(previewUrl(extracted)); if (!response.ok) throw new Error(`读取姿势图失败（HTTP ${response.status}）`);
                const blob = await response.blob(); const uploaded = await uploadImage(new File([blob], extracted.filename, { type: blob.type || "image/png" })); uploaded.slotKey = slotKey;
                const preset = PRESETS[activeMode]; const managedTemplate = positive.value === templateFor(preset, workbench.states[activeMode].option, assets);
                const index = assets.findIndex((item) => item.slotKey === slotKey); if (index >= 0) assets.splice(index, 1, uploaded); else assets.push(uploaded);
                if (managedTemplate) { sortAssets(preset); positive.value = templateFor(preset, workbench.states[activeMode].option, assets); }
                persist(); renderAll(); setStatus(`姿势图已放入：${roleLabel(PRESETS[activeMode], uploaded, assets.indexOf(uploaded))}`); close();
            } catch (error) { setMessage(String(error?.message || error), true); useButton.disabled = false; }
        };
    };

    uploadButton.onclick = () => { if (controlledTask) return setStatus("已接入资产分镜，不能手动上传。", true); pendingRole = null; fileInput.click(); }; fileInput.onchange = () => addFiles(fileInput.files);
    root.addEventListener("dragover", (event) => { if (event.dataTransfer?.types?.includes("Files")) event.preventDefault(); });
    root.addEventListener("drop", (event) => { if (!event.dataTransfer?.files?.length) return; event.preventDefault(); pendingRole = null; addFiles(event.dataTransfer.files); });
    root.addEventListener("paste", (event) => { const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean); if (files.length) { event.preventDefault(); pendingRole = null; addFiles(files); } });
    positiveEditor.addEventListener("input", () => { if (controlledTask) return; syncPositiveText(); rememberPositiveRange(); persist(); });
    positiveEditor.addEventListener("keyup", rememberPositiveRange); positiveEditor.addEventListener("mouseup", rememberPositiveRange); positiveEditor.addEventListener("focus", rememberPositiveRange);
    const isolatedShortcutKeys = new Set(["a", "c", "v", "x", "y", "z"]);
    const isolateEditorEvents = (editor) => {
        editor.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && isolatedShortcutKeys.has(String(event.key || "").toLowerCase())) event.stopPropagation(); });
        editor.addEventListener("keyup", (event) => { if ((event.ctrlKey || event.metaKey) && isolatedShortcutKeys.has(String(event.key || "").toLowerCase())) event.stopPropagation(); });
        ["copy", "cut", "paste"].forEach((type) => editor.addEventListener(type, (event) => event.stopPropagation(), true));
    };
    isolateEditorEvents(positiveEditor); isolateEditorEvents(negative);
    positiveEditor.addEventListener("paste", (event) => { event.stopPropagation(); if ([...(event.clipboardData?.items || [])].some((item) => item.kind === "file" && item.type.startsWith("image/"))) return; event.preventDefault(); document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") || ""); });
    negative.oninput = () => { if (!controlledTask) persist(); };
    root.querySelector("[data-reset-positive]").onclick = () => { if (!controlledTask) applyPromptTemplate(); };
    root.querySelector("[data-reset-negative]").onclick = () => { if (!controlledTask) { negative.value = withHandNegative(PRESETS[activeMode].negative); persist(); } };
    applyTemplateButton.onclick = () => { if (!controlledTask) applyPromptTemplate(); };
    taskNav.querySelectorAll("button").forEach((button) => { button.onclick = () => switchTask(button.dataset.task); });
    root.querySelector("[data-shot-add]").onclick = () => addShot(false);
    root.querySelector("[data-shot-clear]").onclick = clearShots;
    root.querySelector("[data-shot-left]").onclick = () => moveShot(-1);
    root.querySelector("[data-shot-right]").onclick = () => moveShot(1);
    root.querySelector("[data-shot-delete]").onclick = deleteShot;
    generateCurrentButton.onclick = () => { const shot = activeShot(); if (shot) queueShots([clone(shot)]); };
    generateAllButton.onclick = () => {
        const checked = storyboard.shots.filter((shot) => shot.batchSelected);
        const activeIndex = Math.max(0, storyboard.shots.findIndex((shot) => shot.id === activeShotId));
        const requested = checked.length ? checked : storyboard.shots.slice(activeIndex);
        queueShots(requested.map((shot) => ({ id: shot.id })));
    };

    const syncFromNode = () => { const initialWorkbench = normalizeWorkbench(); storyboard = normalizeStoryboard(initialWorkbench); activeShotId = storyboard.activeShotId; workbench = clone(activeShot()?.workbench || initialWorkbench); activeMode = PRESETS[workbench.activeMode] ? workbench.activeMode : "free_edit"; workbench.states[activeMode] ||= newState(activeMode); if (node.properties) delete node.properties.xiantuQwen21Mtp; loadMode(activeMode); if (!linkedStoryboardTask(node)) persist(); else renderAll(); };
    root.__xq21Sync = syncFromNode; syncFromNode();
    return root;
}

app.registerExtension({
    name: "Xiantu.QwenImage21Director",
    async nodeCreated(node) {
        if (String(node.comfyClass || node.type || "") !== NODE_NAME) return;
        node.title = NODE_TITLE;
        const root = createDirectorUi(node);
        const domWidget = node.addDOMWidget("xiantu_qwen21_director_ui", "div", root, { serialize: false, hideOnZoom: false, getMinHeight: () => Math.ceil(root.scrollHeight || 560), getMaxHeight: () => Math.ceil(root.scrollHeight || 560), getValue: () => undefined, setValue: () => {} });
        domWidget.computeSize = (width) => [Math.max(10, width), Math.ceil(root.scrollHeight || 560)];
        const observer = new ResizeObserver(() => node.setDirtyCanvas?.(true, true)); observer.observe(root);
        const previousConfigure = node.onConfigure; node.onConfigure = function () { previousConfigure?.apply(this, arguments); this.title = NODE_TITLE; requestAnimationFrame(() => root.__xq21Sync?.()); };
        const previousConnectionsChange = node.onConnectionsChange; node.onConnectionsChange = function () { previousConnectionsChange?.apply(this, arguments); requestAnimationFrame(() => root.__xq21Sync?.()); };
        const previousRemoved = node.onRemoved; node.onRemoved = function () { observer.disconnect(); previousRemoved?.apply(this, arguments); };
        requestAnimationFrame(() => root.__xq21Sync?.());
    },
});
