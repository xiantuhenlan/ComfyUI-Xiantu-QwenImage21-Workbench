# 节点与修改范围指纹门禁

本插件使用 SHA256 同时保护“节点功能区域”和“插件文件”。目的不是证明功能正确，而是证明一次修改有没有越过事先声明的范围。

## 固定流程

1. 先列出节点内部的全部功能指纹：

   `python tools/node_integrity.py report`

2. 修改前同时声明节点和预计修改的具体功能：

   `python tools/node_integrity.py begin --reason "任务说明" --allow-node 节点注册名 --allow-feature 节点注册名::功能ID`

   可重复传入 `--allow-node` 和 `--allow-feature`。每个允许节点必须至少声明一个预计修改功能；确需修改共享文件时可追加 `--allow-file 相对路径`。

3. 修改功能，只改 `integrity/change_scope.json` 中列出的预计修改功能。该节点的其余功能和其他全部节点继续受保护。

4. 修改后校验：

   `python tools/node_integrity.py verify-scope`

   受保护节点、受保护文件、未声明新增/删除项只要发生变化，命令就会失败并列出具体名称。

5. 用户验收后才允许更新正式基线：

   `python tools/node_integrity.py snapshot`

6. 随时核对完整基线：

   `python tools/node_integrity.py verify`

## 规则

- `integrity/node_fingerprints.json` 是当前正式基线，包含每个注册节点、节点内每项功能及插件受控文件的独立指纹。
- `integrity/change_scope.json` 是单次任务的修改前快照，明确区分预计修改功能、同节点未修改功能、其他保护节点和保护文件。
- 后端按节点类的每个方法单独指纹，并额外保护类结构、字段和非方法代码。
- 前端按每个具名函数单独指纹，并额外保护常量、HTML模板、事件注册等非函数区域。
- 多个节点共用同一个前端文件时，修改该文件会同时触发这些节点的指纹变化；必须明确扩大允许节点范围，不能静默绕过。
- 不得在范围校验失败时直接重建基线。先查明越界变化并恢复或让用户明确批准扩大范围。
