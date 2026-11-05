#!/usr/bin/env python3
"""Node-level and file-level SHA256 guard for XiantuQwenImage21Director."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INTEGRITY_DIR = ROOT / "integrity"
BASELINE_PATH = INTEGRITY_DIR / "node_fingerprints.json"
SCOPE_PATH = INTEGRITY_DIR / "change_scope.json"
ACTIVE_WEB = "web_20261004_upload_fix"
IGNORED_PARTS = {".git", ".ruff_cache", "__pycache__", "integrity"}
ROOT_FILES = {
    ".comfyignore", ".gitignore", "CHANGELOG.md", "LICENSE", "README.md",
    "MOSS_IMAGE_OFFICIAL_PROMPT_REFERENCE.md", "UPDATE_RULES.md",
    "plugin_manifest.json", "pyproject.toml", "requirements.txt",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def tracked_files() -> list[Path]:
    result: list[Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or any(part in IGNORED_PARTS for part in path.relative_to(ROOT).parts):
            continue
        rel = path.relative_to(ROOT)
        if len(rel.parts) == 1:
            if path.suffix == ".py" or path.name in ROOT_FILES:
                result.append(path)
        elif rel.parts[0] in {"digital_human_v2_impl", "integrations", "tools"}:
            if path.suffix.lower() in {".py", ".js", ".css", ".json", ".md", ".toml", ".txt"}:
                result.append(path)
        elif rel.parts[0] == ACTIVE_WEB:
            if path.suffix.lower() in {".js", ".css", ".json", ".png", ".jpg", ".jpeg", ".webp", ".svg"}:
                result.append(path)
    return sorted(set(result), key=relative)


def literal_string(node: ast.AST | None) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def mapping_assignments(tree: ast.AST, name: str) -> list[ast.Dict]:
    dictionaries: list[ast.Dict] = []
    for item in ast.walk(tree):
        if not isinstance(item, (ast.Assign, ast.AnnAssign)):
            continue
        targets = item.targets if isinstance(item, ast.Assign) else [item.target]
        value = item.value
        if any(isinstance(target, ast.Name) and target.id == name for target in targets) and isinstance(value, ast.Dict):
            dictionaries.append(value)
    return dictionaries


def frontend_files_for(node_name: str) -> list[str]:
    matches = []
    web_root = ROOT / ACTIVE_WEB
    if not web_root.exists():
        return matches
    for path in web_root.rglob("*.js"):
        text = path.read_text(encoding="utf-8-sig")
        declared = set(re.findall(r'\bconst\s+(?:NODE|NODE_NAME|NODE_CLASS)\s*=\s*["\']([^"\']+)["\']', text))
        config_match = re.search(r"\bconst\s+NODE_CONFIGS\s*=\s*\{", text)
        if config_match:
            opening = text.find("{", config_match.start(), config_match.end())
            ending = find_matching_brace(text, opening) if opening >= 0 else None
            if ending:
                block = text[opening:ending]
                declared.update(re.findall(r'^[ \t]*["\']([^"\']+)["\']\s*:', block, re.MULTILINE))
        if node_name in declared:
            matches.append(relative(path))
    return sorted(matches)


def python_class_features(source: str, class_node: ast.ClassDef) -> dict[str, dict]:
    lines = source.splitlines()
    features: dict[str, dict] = {}
    method_ranges: list[tuple[int, int, str]] = []
    duplicate_counts: dict[str, int] = {}
    for item in class_node.body:
        if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) or not item.end_lineno:
            continue
        duplicate_counts[item.name] = duplicate_counts.get(item.name, 0) + 1
        suffix = f"#{duplicate_counts[item.name]}" if duplicate_counts[item.name] > 1 else ""
        feature_id = f"backend::{item.name}{suffix}"
        data = "\n".join(lines[item.lineno - 1:item.end_lineno]).encode("utf-8")
        features[feature_id] = {
            "kind": "backend-method",
            "name": item.name,
            "lines": [item.lineno, item.end_lineno],
            "sha256": sha256_bytes(data),
        }
        method_ranges.append((item.lineno, item.end_lineno, feature_id))
    remainder_lines = lines[class_node.lineno - 1:class_node.end_lineno]
    for start, end, feature_id in sorted(method_ranges, reverse=True):
        local_start = start - class_node.lineno
        local_end = end - class_node.lineno + 1
        remainder_lines[local_start:local_end] = [f"<FUNCTION:{feature_id}>"]
    features["backend::__class_remainder__"] = {
        "kind": "backend-remainder",
        "name": "类结构、字段与非方法代码",
        "lines": [class_node.lineno, class_node.end_lineno],
        "sha256": sha256_bytes("\n".join(remainder_lines).encode("utf-8")),
    }
    return features


def find_matching_brace(text: str, opening: int) -> int | None:
    depth, index, quote = 0, opening, ""
    escaped, line_comment, block_comment = False, False, False
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ""
        if line_comment:
            if char == "\n":
                line_comment = False
        elif block_comment:
            if char == "*" and nxt == "/":
                block_comment = False
                index += 1
        elif quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
        elif char == "/" and nxt == "/":
            line_comment = True
            index += 1
        elif char == "/" and nxt == "*":
            block_comment = True
            index += 1
        elif char in {"'", '"', "`"}:
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return None


def javascript_features(path: Path) -> dict[str, dict]:
    text = path.read_text(encoding="utf-8-sig")
    patterns = [
        re.compile(r"\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{"),
        re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^\{]*|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)\s*\{"),
    ]
    candidates: list[tuple[int, int, str]] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            opening = text.find("{", match.start(), match.end())
            ending = find_matching_brace(text, opening) if opening >= 0 else None
            if ending:
                candidates.append((match.start(), ending, match.group(1)))
    regions: list[tuple[int, int, str]] = []
    for start, end, name in sorted(candidates):
        if any(existing_start <= start < existing_end for existing_start, existing_end, _ in regions):
            continue
        regions.append((start, end, name))
    features: dict[str, dict] = {}
    duplicate_counts: dict[str, int] = {}
    rel = relative(path)
    for start, end, name in regions:
        duplicate_counts[name] = duplicate_counts.get(name, 0) + 1
        suffix = f"#{duplicate_counts[name]}" if duplicate_counts[name] > 1 else ""
        feature_id = f"frontend::{rel}::{name}{suffix}"
        features[feature_id] = {
            "kind": "frontend-function",
            "name": name,
            "file": rel,
            "lines": [text.count("\n", 0, start) + 1, text.count("\n", 0, end) + 1],
            "sha256": sha256_bytes(text[start:end].encode("utf-8")),
        }
    remainder = text
    for start, end, name in reversed(regions):
        remainder = remainder[:start] + f"<FUNCTION:{name}>" + remainder[end:]
    features[f"frontend::{rel}::__remainder__"] = {
        "kind": "frontend-remainder",
        "name": "前端结构、常量、模板与非函数代码",
        "file": rel,
        "sha256": sha256_bytes(remainder.encode("utf-8")),
    }
    return features


def discover_nodes() -> dict[str, dict]:
    nodes: dict[str, dict] = {}
    python_files = [path for path in tracked_files() if path.suffix == ".py" and "tools" not in path.parts]
    for path in python_files:
        source = path.read_text(encoding="utf-8-sig")
        try:
            tree = ast.parse(source, filename=str(path))
        except SyntaxError as error:
            raise RuntimeError(f"无法解析 {relative(path)}: {error}") from error
        classes = {item.name: item for item in ast.walk(tree) if isinstance(item, ast.ClassDef)}
        display_names: dict[str, str] = {}
        for mapping in mapping_assignments(tree, "NODE_DISPLAY_NAME_MAPPINGS"):
            for key, value in zip(mapping.keys, mapping.values):
                key_text, value_text = literal_string(key), literal_string(value)
                if key_text and value_text:
                    display_names[key_text] = value_text
        for mapping in mapping_assignments(tree, "NODE_CLASS_MAPPINGS"):
            for key, value in zip(mapping.keys, mapping.values):
                node_name = literal_string(key)
                if not node_name:
                    continue
                class_name = value.id if isinstance(value, ast.Name) else ast.unparse(value)
                class_node = classes.get(class_name)
                if class_node and class_node.end_lineno:
                    region = "\n".join(source.splitlines()[class_node.lineno - 1:class_node.end_lineno]).encode("utf-8")
                    region_hash = sha256_bytes(region)
                    line_range = [class_node.lineno, class_node.end_lineno]
                    features = python_class_features(source, class_node)
                else:
                    region_hash = sha256_file(path)
                    line_range = None
                    features = {"backend::__file_fallback__": {"kind": "backend-file", "name": "后端文件", "sha256": region_hash}}
                frontends = frontend_files_for(node_name)
                for frontend in frontends:
                    features.update(javascript_features(ROOT / frontend))
                component_hashes = [f"{feature_id}:{item['sha256']}" for feature_id, item in sorted(features.items())]
                nodes[node_name] = {
                    "displayName": display_names.get(node_name, node_name),
                    "className": class_name,
                    "backendFile": relative(path),
                    "backendFileSha256": sha256_file(path),
                    "backendRegionLines": line_range,
                    "backendRegionSha256": region_hash,
                    "frontendFiles": frontends,
                    "features": dict(sorted(features.items())),
                    "fingerprint": sha256_bytes("\n".join(component_hashes).encode("utf-8")),
                }
    return dict(sorted(nodes.items()))


def current_snapshot() -> dict:
    files = {relative(path): {"sha256": sha256_file(path), "size": path.stat().st_size} for path in tracked_files()}
    return {
        "schema": 1,
        "algorithm": "SHA256",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "plugin": "XiantuQwenImage21Director",
        "activeWebDirectory": ACTIVE_WEB,
        "nodes": discover_nodes(),
        "files": files,
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_json(path: Path) -> dict:
    if not path.exists():
        raise RuntimeError(f"缺少文件：{relative(path)}")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def compare(before: dict, after: dict) -> dict:
    before_nodes, after_nodes = before.get("nodes", {}), after.get("nodes", {})
    before_files, after_files = before.get("files", {}), after.get("files", {})
    return {
        "changedNodes": sorted(name for name in before_nodes.keys() & after_nodes.keys() if before_nodes[name].get("fingerprint") != after_nodes[name].get("fingerprint")),
        "addedNodes": sorted(after_nodes.keys() - before_nodes.keys()),
        "removedNodes": sorted(before_nodes.keys() - after_nodes.keys()),
        "changedFiles": sorted(name for name in before_files.keys() & after_files.keys() if before_files[name].get("sha256") != after_files[name].get("sha256")),
        "addedFiles": sorted(after_files.keys() - before_files.keys()),
        "removedFiles": sorted(before_files.keys() - after_files.keys()),
    }


def has_changes(diff: dict) -> bool:
    return any(diff.values())


def print_diff(diff: dict) -> None:
    labels = {
        "changedNodes": "节点变化", "addedNodes": "新增节点", "removedNodes": "删除节点",
        "changedFiles": "文件变化", "addedFiles": "新增文件", "removedFiles": "删除文件",
    }
    for key, label in labels.items():
        values = diff.get(key, [])
        print(f"{label} ({len(values)})")
        for value in values:
            print(f"  - {value}")


def command_snapshot(_: argparse.Namespace) -> int:
    snapshot = current_snapshot()
    write_json(BASELINE_PATH, snapshot)
    print(f"已建立节点指纹基线：{len(snapshot['nodes'])} 个节点，{len(snapshot['files'])} 个文件")
    return 0


def command_verify(_: argparse.Namespace) -> int:
    baseline, current = load_json(BASELINE_PATH), current_snapshot()
    diff = compare(baseline, current)
    print_diff(diff)
    if has_changes(diff):
        print("基线校验失败：存在未登记变化。", file=sys.stderr)
        return 2
    print("基线校验通过：节点与文件均未变化。")
    return 0


def command_begin(args: argparse.Namespace) -> int:
    current = current_snapshot()
    allowed_nodes = set(args.allow_node)
    new_nodes = set(args.add_node)
    existing = sorted(new_nodes & current["nodes"].keys())
    if existing:
        raise RuntimeError("新增节点已经存在：" + "、".join(existing))
    unknown = sorted(allowed_nodes - current["nodes"].keys())
    if unknown:
        raise RuntimeError("未知允许节点：" + "、".join(unknown))
    allowed_nodes.update(new_nodes)
    allowed_features: dict[str, set[str]] = {name: set() for name in allowed_nodes}
    for specification in args.allow_feature:
        if "::" not in specification:
            raise RuntimeError(f"功能声明必须是 节点名::功能ID：{specification}")
        node_name, feature_id = specification.split("::", 1)
        if node_name not in allowed_nodes:
            raise RuntimeError(f"功能所属节点未通过 --allow-node 声明：{node_name}")
        allowed_features[node_name].add(feature_id)
    missing_feature_scope = sorted(name for name in allowed_nodes if not allowed_features[name])
    if missing_feature_scope:
        raise RuntimeError("以下节点没有声明预计修改的具体功能：" + "、".join(missing_feature_scope))
    allowed_files = {Path(item).as_posix() for item in args.allow_file}
    if new_nodes and not allowed_files:
        raise RuntimeError("新增节点必须显式声明允许新增的文件")
    for node_name in allowed_nodes - new_nodes:
        item = current["nodes"][node_name]
        allowed_files.add(item["backendFile"])
        allowed_files.update(item["frontendFiles"])
    protected_features = {
        node_name: sorted(set(current["nodes"][node_name].get("features", {})) - allowed_features.get(node_name, set()))
        for node_name in allowed_nodes - new_nodes
    }
    scope = {
        "schema": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "reason": args.reason,
        "allowedNodes": sorted(allowed_nodes),
        "newNodes": sorted(new_nodes),
        "protectedNodes": sorted(set(current["nodes"]) - allowed_nodes),
        "allowedFeatures": {name: sorted(values) for name, values in sorted(allowed_features.items())},
        "protectedFeatures": protected_features,
        "allowedFiles": sorted(allowed_files),
        "protectedFiles": sorted(set(current["files"]) - allowed_files),
        "before": current,
    }
    write_json(SCOPE_PATH, scope)
    allowed_feature_count = sum(len(values) for values in scope["allowedFeatures"].values())
    protected_feature_count = sum(len(values) for values in scope["protectedFeatures"].values())
    print(f"修改范围已锁定：预计修改 {allowed_feature_count} 项功能；同节点保护 {protected_feature_count} 项功能；另外完整保护 {len(scope['protectedNodes'])} 个节点、{len(scope['protectedFiles'])} 个文件")
    return 0


def command_verify_scope(_: argparse.Namespace) -> int:
    scope, current = load_json(SCOPE_PATH), current_snapshot()
    before = scope["before"]
    diff = compare(before, current)
    allowed_nodes, allowed_files = set(scope.get("allowedNodes", [])), set(scope.get("allowedFiles", []))
    allowed_features = {name: set(values) for name, values in scope.get("allowedFeatures", {}).items()}
    violations: list[str] = []
    for name in scope.get("newNodes", []):
        if name not in diff["addedNodes"]:
            violations.append(f"声明的新增节点未新增：{name}")
    changed_file_names = set(diff["changedFiles"] + diff["addedFiles"] + diff["removedFiles"])
    tooling_only = bool(changed_file_names) and all(name.startswith("tools/") for name in changed_file_names)
    if not tooling_only:
        for name in diff["changedNodes"] + diff["removedNodes"]:
            if name not in allowed_nodes:
                violations.append(f"受保护节点发生变化：{name}")
        for name in diff["addedNodes"]:
            if name not in allowed_nodes:
                violations.append(f"出现未声明新增节点：{name}")
    for name in diff["changedFiles"] + diff["removedFiles"]:
        if name not in allowed_files:
            violations.append(f"受保护文件发生变化：{name}")
    for name in diff["addedFiles"]:
        if name not in allowed_files:
            violations.append(f"出现未声明新增文件：{name}")
    for node_name in (() if tooling_only else allowed_nodes):
        before_features = before.get("nodes", {}).get(node_name, {}).get("features", {})
        after_features = current.get("nodes", {}).get(node_name, {}).get("features", {})
        permitted = allowed_features.get(node_name, set())
        changed = sorted(name for name in before_features.keys() & after_features.keys() if before_features[name].get("sha256") != after_features[name].get("sha256"))
        added = sorted(after_features.keys() - before_features.keys())
        removed = sorted(before_features.keys() - after_features.keys())
        for feature_id in changed:
            if feature_id not in permitted:
                violations.append(f"节点 {node_name} 的未声明功能发生变化：{feature_id}")
        for feature_id in added:
            if feature_id not in permitted:
                violations.append(f"节点 {node_name} 出现未声明新增功能：{feature_id}")
        for feature_id in removed:
            if feature_id not in permitted:
                violations.append(f"节点 {node_name} 的未声明功能被删除：{feature_id}")
    print_diff(diff)
    if tooling_only:
        print("工具迁移模式：除 tools/ 外没有源码变化；节点指纹差异仅作为新算法迁移结果报告。")
    if violations:
        print("范围校验失败：", file=sys.stderr)
        for violation in violations:
            print(f"  - {violation}", file=sys.stderr)
        return 3
    print("范围校验通过：变化仅发生在声明允许的节点和文件内。")
    return 0


def command_report(_: argparse.Namespace) -> int:
    current = current_snapshot()
    print(f"节点数：{len(current['nodes'])}；受控文件数：{len(current['files'])}")
    for name, item in current["nodes"].items():
        print(f"{name}\t{item['displayName']}\t{item['fingerprint']}\t{item['backendFile']}")
        for feature_id, feature in item.get("features", {}).items():
            print(f"  {name}::{feature_id}\t{feature['sha256']}\t{feature['name']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("snapshot", help="建立或更新完整基线").set_defaults(func=command_snapshot)
    sub.add_parser("verify", help="对比完整基线").set_defaults(func=command_verify)
    begin = sub.add_parser("begin", help="修改前锁定允许/保护范围")
    begin.add_argument("--reason", required=True)
    begin.add_argument("--allow-node", action="append", default=[])
    begin.add_argument("--add-node", action="append", default=[], help="显式声明尚不存在的新节点；仍须声明功能和文件")
    begin.add_argument("--allow-feature", action="append", default=[], help="节点名::功能ID，可重复")
    begin.add_argument("--allow-file", action="append", default=[])
    begin.set_defaults(func=command_begin)
    sub.add_parser("verify-scope", help="修改后验证未越界").set_defaults(func=command_verify_scope)
    sub.add_parser("report", help="列出当前全部节点指纹").set_defaults(func=command_report)
    return parser


def main() -> int:
    try:
        args = build_parser().parse_args()
        return args.func(args)
    except Exception as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
