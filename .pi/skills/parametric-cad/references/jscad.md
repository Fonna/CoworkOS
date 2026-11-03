# JSCAD 源码工程

仅在当前 model.engine 为 jscad 时使用。CommonJS 使用 require('@jscad/modeling')，main(params) 返回 geom3 或嵌套实体数组，getParameterDefinitions() 提供人工参数。Z 向上，尺寸 mm，旋转角度弧度。运行在隔离 QuickJS 中，无宿主文件、网络或其他包。

cad_run_program 可在同一文件运行并提交源码/指定参数；失败保持当前保存工程。只有确实需要保存未通过计算的草稿时才用 cad_write_program，随后 cad_preview；cad_set_parameters 兼容旧调用。不要让保存成功替代几何检查。

不确定签名时查询 cad_get_api_reference({module:"extrusions",member:"extrudeRotate"})。旋转轮廓点 [半径,轴向高度]，extrudeRotate 返回绕 Z 的实体，不再转一次轴。尾翼均布时位置也要按角度改变，不只是旋转形体。

继续旧设计时保留源码、人工覆盖和已有部件；JSON/JSCAD/STL/PNG 导出可用，STL 为网格。需要 STEP 时才在同一文件显式 engine:"cadquery" 并完整重写 Python；不能声称网格自动恢复精确曲面。交互基本形体编辑器的限制不适用于源码内核。
