# gm-typemaster

给 GMEdit 补上「自动类型推断」：不用写 `var x:Type`，输入 `x.` 就能列出结构体字段。

## 它做七件事

1. **补强 GMEdit 内置的类型推断**
   打开 `Preferences → Linter → Implicit types` 里的 `var / static / let / const / 其他宏 / 实例变量`
   几个开关（插件首次启动时会自动打开）。打开后 `var u = new Unit()`、构造函数里的 `hp = 100`
   都会被自动记下类型，`u.`、`self.` 的补全立刻变丰富。

2. **补上 GMEdit 完全不推断的两类情况**
   - **结构体字面量**：`var u = { hp: 100, name: "orc", pos: { x: 0, y: 0 } }`
     → `u.` 列出 `hp / name / pos`，嵌套结构也能继续往下点。
   - **函数返回值**：函数怎么写都认，两种定义形式都支持：
     ```gml
     function make_unit() { return { hp: 100 }; }   // 脚本里的常规写法
     make_unit = function() { return { hp: 100 }; } // 对象事件里最常见的写法
     ```
     之后 `var a = make_unit(); a.` 直接列出那个 return 出来的结构体字段；`return new Boss()`
     则推断为 `Boss`。
     注意「赋值式函数」在对象事件里属于**实例方法**（运行时不进全局作用域），所以它只参与
     **本文件**的推断；跨文件索引只收 `scripts/` 里的赋值式函数和所有 `function name()` 声明。
   - **跨文件**：函数写在 `scripts/xxx.gml`、调用写在对象事件里也能识别。
     插件启动后会扫描工程内 `scripts/` 与 `objects/` 下的所有 `.gml`，为每个函数记下
     第一个 `return` 的形状；调用处的类型由这张索引补齐，本地定义优先。
     改动了脚本里的 `return` 之后，执行 `TypeMaster: Refresh inferred types` 重建索引。

3. **识别实例 id 的类型**（GML 对象实例）
   ```gml
   var e = instance_create_layer(x, y, "Instances", obj_enemy);
   e.            // 弹出 obj_enemy 的全部实例变量（hp / atk / ...）
   ```
   支持：`instance_create`、`instance_create_layer`、`instance_create_depth`、`instance_find`、
   `instance_nearest`、`instance_furthest`、`instance_position`、`instance_place`、
   `instance_position_list`、`instance_place_list`；也支持把对象资源直接赋值（`var o = obj_enemy`）、
   经函数转发（`function spawn() { return instance_create_layer(..., obj_boss); }`）、
   以及结构体字段（`{ target: obj_enemy }` 或 `{ target: instance_create_layer(...) }`）。

   推断结果通过往编辑器自己的类型表里注入「合成命名空间」实现，所以
   用的是 GMEdit 原生补全弹窗、排序和工具提示，不会出现重复条目。
   对象成员直接复用 GMEdit 已经索引好的 `obj_xxx` 命名空间（含对象 Variable Definitions 与
   各事件里赋值的变量），因此不需要重复解析对象文件。

4. **让 `/// @is` 对局部变量生效**
   原版 `@is` 只覆盖结构体/实例字段和 `global` 变量，写在 `var` 后面会被直接忽略。插件补上了这条：

   ```gml
   var _item_par_inst = _par_inst; /// @is {obj_item_parent}
   var _x;                         /// @is {obj_enemy}
   /// @is {obj_enemy}
   var _above = spawn_unknown();
   ```

   三种位置都认（同行、上一行、无初始化的声明）。显式注记**优先级最高**，会覆盖 GMEdit 内置推断
   和本插件自己的推断；注释里的类型只取主名，`{struct<...>}` 之类的泛型参数会被忽略。
   注记是补全时读取的，改完不需要保存或重载工程，直接继续输入即可。

5. **中键点击跳转到定义**
   GMEdit 本来就把鼠标中键绑在 `ui.OpenDeclaration.proc` 上：点上引擎自带函数（`instance_create_layer`、
   `array_push`…）会打开官方手册网页；点上它自己索引到的东西会跳过去。但它只认识索引器收录的部分，
   用户自己写的函数、对象事件里的方法、实例变量、局部变量点上去毫无反应。

   插件接管了「原生没解析出来」的这一步：

   ```gml
   Menu_item_to_struct(_inst);   // 中键点 Menu_item_to_struct → 跳到 scripts/scr_menu_main/scr_menu_main.gml:143
   L_release_func();             // 中键点 → 跳到定义它的那个对象事件
   hp                            // 中键点 → 跳到赋值的那个事件
   ```

   - 接管位置：**DOM 捕获阶段**（`document` 上的 `mousedown` + `capture`），在 Ace 和 GMEdit
     自己的中键处理之前就拿到这次点击。用户符号 → 跳转并吞掉事件；其余一律原样放行，
     所以自带函数开网页、资源跳转、颜色拾取、树形视图的中键操作全部保持原状。
   - **为什么以前点自己的方法也会开网页**：原生 `proc` 最后一步是「实在解析不出来就打开手册的
     *搜索* 页」，并且返回 `true`。GMS 2.3+ 的 API 配置里只有 `helpURL`、没有 `helpIndex`，
     所以 `helpLookup` 一直是 `null`，于是**任何**用户符号都会走到那个搜索页。早期版本靠
     「原生先跑、失败再接管」以及临时置空 `helpURL` 绕开它，前者被这一步吞掉、后者依赖
     hook 一定装上；现在改成捕获阶段拦截，不再依赖 GMEdit 内部的调用链。
   - `ui.OpenDeclaration.proc` 上仍保留一层兜底：万一捕获阶段没拿到（例如光标不在编辑器内），
     能解析的名字仍然会跳过搜索页并跳转；解析不到、又不是 GMEdit 认识的名字（即用户符号）时，
     同样不再打开搜索页——那种页面只是「搜一个不存在的词」，从来没有用。
   - 查找顺序：接收者类型（`_inst.Open_item()` 里 `_inst` 推断出的对象）→ 当前文件 → 工程索引
     （`scripts/` + `objects/`）→ 按接收者对象直接扫该对象目录（同名方法在全工程有 19 处定义时，
     索引只留前 6 条，这一步保证不会挑错对象）。
   - **首次点击就能用**：工程索引原本是插件启动后异步建立的，建立之前的点击会落到「开网页」。
     现在中键解析发现索引还没建好时会先同步建一次（约 0.3s，一次性），所以刚打开工程/刚 `Ctrl+R`
     之后的第一下点击也能直接跳。
   - 找到定义但打开失败（文件被锁、工程还没加载完）时也**吞掉这次点击**，不会再掉到搜索页去。
   - 对象事件是按「对象 `.yy` + 事件名」定位的，GMEdit 把整个对象放在一个标签页里、用
     `#event create` 这样的分段；插件会先切到对应事件段，再按名字定位到具体那一行，
     不受文件头 `///` 被搬到分段行的影响。
   - 认得：`function name()`、`name = function()`、`var/static/let/const name =`、`name = ...`、
     `#macro`、`enum`、`global.NAME =`。同一个名字有多处定义时，优先接收者对象的那一处，
     其次当前文件，再次索引里靠前的。
   - 索引随启动建立；新加的函数点不到时执行一次 `TypeMaster: Refresh inferred types`。

6. **右侧大纲（Outline View）列出事件里的成员**
   内置 `outline-view` 插件只到 `#event create` 这一层就停了，事件下面永远是空的：
   它认成员的正则要求行首有缩进，而对象事件里的代码是从第 0 列开始写的；
   另外它从来不列普通变量。插件接管了它的 gml 解析，事件下会多出一层：

   ```
   obj_itemmenu_open
     properties
     create
       ƒ L_release_func()
       ▪ _count
     step
       ƒ L_release_func()
   ```

   - `ƒ` = 方法/函数变量，`▪` = 事件里直接声明的 `var / static / let / const`。
   - 只列**事件这一层直接声明**的东西（大括号深度 0）。函数体内部的局部变量不列，
     否则一个 Create 事件会刷出几十行、层级也看不出归属。
   - 脚本文件里顶格的 `name = function()` 现在是**独立节点**（以前要么不显示、
     要么被错误地嵌进上一个函数下面）。
   - 点这些节点会跳到事件里对应的那一行；光标移到方法体内时，对应的节点会高亮。
   - `#region` / `//#mark` 的折叠层级保持原样。
   - 选项沿用 outline-view 自己的「显示函数参数」「滚动到顶部」，没有新增开关。
   - 代价：只有打开的标签页会被重新扫描，平均 0.6ms/文件（1.8 万行的大文件约 28ms）。

7. **`global.NAME` 的结构体字段**
   GMEdit 会解析出「有哪些全局变量」（输入 `global.` 能列出来），但**从不记录它们的值长什么样**，
   所以 `global.DATA_STRUCT.` 永远是空的。插件补上这一层：

   ```gml
   // scripts/game_init/game_init.gml
   global.DATA_STRUCT =
   {
       GAME_STATE : GAME_STATE_TYPE.IDLE,
       PLACE_ITEM : noone,
       WILL_PLACE_DATA : { SPRITE : -1, OBJ : -1, FLAT_OR_FACE : 0 },
   }

   // 任意对象的任意事件里
   global.DATA_STRUCT.            // GAME_STATE / PLACE_ITEM / WILL_PLACE_DATA ...
   global.DATA_STRUCT.WILL_PLACE_DATA.   // SPRITE / OBJ / FLAT_OR_FACE
   ```

   - 支持 `global.X = { ... }`、`= new Foo()`、`= instance_create_layer(..., obj_x)`、`= []`，
     以及 `global.X.field = ...` 这种「先建空结构、后面逐字段填」的写法（追加缺失的字段，
     已有字段不覆盖）。
   - **跨文件**：`global` 通常只在 `scripts/` 里定义一次、到处使用。工程索引会为每个全局记下形状，
     在别的文件里输入 `global.X.` 一样有效。
   - 注入点：`gml.GmlAPI.gmlGlobalTypes[NAME] = GmlTypeDef.simple("$tm.N")` —— 这正是 GMEdit
     自己 linter 解析 `global.NAME` 时查的表（`global` 是类型 kind 8），所以嵌套链
     `global.X.a.b.` 也能继续往下解析，用的仍然是原生补全弹窗。
   - 自己用 `/// @is` 标注过的 `global` 不会被覆盖。
   - 中键点 `global.DATA_STRUCT` 里的 `DATA_STRUCT` 会跳到定义它的那一行（`global.DATA_STRUCT =`）。

## 安装 / 生效
插件目录：`%APPDATA%\AceGM\GMEdit\plugins\gm-typemaster\`

- 新增插件后需要重载：`Preferences → 其他有用功能 → Reload GMEdit`，或 `Ctrl+R`。
- 首次启动会自动打开上面提到的 linter 开关，之后建议再 `Ctrl+R` 重载一次工程让已有文件重新推断。

### 直接拷到别的电脑用

整个 `gm-typemaster` 目录是可移植的：插件里没有写死的盘符或用户路径，工程根目录
（`gml.Project.current.dir`）、GMEdit 安装位置、`node` 模块都是运行时才取。

1. 新机器装好 GMEdit（**尽量同版本**，见下方说明）；
2. `Win+R` → 输入 `%APPDATA%` → 进入 `AceGM\GMEdit\plugins\`（没有 `plugins` 目录就新建）；
3. 把 `gm-typemaster` 整个目录粘进去（保持目录名不变，`config.json` 里的 `name` 要与目录名一致）；
4. 启动 GMEdit、打开 GameMaker 工程，`Ctrl+R` 重载一次；
5. 验证：控制台过滤 `[typemaster]`，应看到 `project index: N file(s), ...`；输入 `xxx.` 能弹字段即生效。

macOS / Linux 的插件目录在 Electron 的 userData 下（macOS 通常 `~/Library/Application Support/AceGM/`，
Linux 通常 `~/.config/AceGM/`），同样建 `GMEdit/plugins/gm-typemaster`。

**版本差异**：插件不是用公开插件 API 写的，而是对接了 GMEdit 的内部实现
（`AceWrapCommonCompleters`、`GmlAPI.gmlGlobalTypes`、内置 `outline-view` 的 `_modeMap`、
`ui.OpenDeclaration.proc` 等）。同一版本或改动不大的版本可直接用；版本差太多时，
补全/中键/大纲中可能有一项失效——每个 hook 都有 `null` 检查与 `try/catch`，
最坏情况是该项静默不生效，不会让编辑器崩。排查仍用 `__typeMaster.dump()` 与 `[typemaster]` 日志。

## 开关

`Preferences → Plugins` 组里有两个复选框：

- **Infer struct fields and return types (TypeMaster)** —— 本插件主体，关掉即完全不介入。
- **Also enable GMEdit's built-in implicit types** —— 等价于手动勾选 Linter 里的 Implicit types。

命令面板里还有两个：

- `TypeMaster: Refresh inferred types` —— 清缓存强制重算。
- `TypeMaster: Debug dump (console)` —— 把当前作用域、已注入的变量类型、import 里的命名空间、分析出的结构体数量打印到控制台；也可以直接在控制台执行 `__typeMaster.dump()`。

## 工程索引（跨文件函数返回值）

插件启动后约 0.8 秒会在后台扫描工程（只读，不改任何文件）：

- 范围：`<工程目录>/scripts/**` 和 `objects/**` 里的 `.gml`，跳过 `tmp`。
- 记录：每个 `function name(...) { ... return ... }`，以及 `scripts/` 里 `name = function(...) {...}`
  的**第一个** `return` 形状（对象事件里的赋值式函数是实例方法，不入索引）。
- 同时记录 `global.NAME = ...` 的值形状（跨文件的 `global.X.` 靠它）。
- 同时记录**定义位置**（`name -> 文件/行/列`，对象事件另存 `.yy` 路径 + 事件名），供中键跳转使用；
  本工程实测 232 文件、9949 个定义点、4430 个符号、20 个带形状的全局。
- 优先级：当前文件里同名函数的定义优先；索引里同名函数先被扫描到的优先。
- 重建：`TypeMaster: Refresh inferred types`，或重载 GMEdit。
- 状态：`__typeMaster.dump()` 里的 `indexReady` / `externalFunctions` / `globalsWithShape` 三个字段。

## 能力边界（这是启发式分析，不是完整编译器）

- 跨文件只覆盖 `scripts/` 和 `objects/` 下的 `.gml`；扩展目录、`datafiles` 不扫。
- 每个函数只取**第一个** `return`，写在 `if` 分支里的提前 return 会占位。
- `return` 一个变量时，取该行之前**最近**的一次赋值推断，不做真正的数据流分析。
- 函数值是 `return { ... }` 或 `return new X()` 时最准；`return 某个变量` 要看那个变量本身推得出来。
- 字段值来自函数参数（`hp: _hp`）时类型未知，只列出名字，不显示类型 —— 参数类型仍需 `@param`。
- 方法成员（`greet: function() {...}`）会被列出，但类型显示为空。
- 只认 `name = 表达式` / `var name = 表达式`；`self.x`、`a.b` 这类成员赋值交给 GMEdit 自己处理。
- `global.X` 只认赋值（`global.X = ...`）。`globalvar`、`#macro` 里指向结构体的名字不推断；
  「先建空结构、后面填」的 `global.X.a.b = ...` 只补一层（`global.X.a` 被追加，再深的 `.b` 不追加）。
- 函数定义两种写法都认（`function name()` / `name = function()`），但 `obj.fn = function(){}`
  这种成员赋值不算，里面 `return` 出来的结构体也就用不上。
- 分析器现在会走进 `xxx = function() { ... }` 的函数体逐句扫描（早期版本会把整块当表达式跳过，
  这也是「脚本文件里能用、对象事件里不能用」的根因之一 —— 对象事件的代码本身几乎都包在这种块里）。
- 对象事件里 `name = function()` 定义的函数是**实例方法**，不进跨文件索引；跨文件只认
  `scripts/` 下的赋值式函数与任意位置的 `function name()` 声明。
- `/// @is` 的局部变量支持只取 `{...}` 里的**单个类型名**；`{struct<a:number>}` 会被当成 `struct`，
  复杂类型请用 `var x:Type` 或 `@typedef`。
- 实例类型要靠**对象名**判断：`instance_create_layer(..., obj_enemy)` 里的那个参数必须是资源名
  （或存着资源名的变量）。`instance_create_layer(..., global.spawn_obj)` 这类运行时才算得出来的
  写法推不出来。
- `with (obj_enemy) { self. }` 不需要本插件：GMEdit 自带 `AceGmlContextResolver`，会按光标位置
  解析最近的 `with` 求 `self` / `other` 类型，嵌套也支持。本插件只补「变量里存着实例 id」这种情况。
- 对象命名空间由 GMEdit 在打开工程时索引；若引用的对象还没被索引，插件会建一个占位命名空间，
  此时只能列出 `x / y / depth / image_index` 等内置实例变量。按 `Ctrl+R` 重载工程后即可补全。
- 中键跳转的范围与上面一致：只覆盖 `scripts/` 与 `objects/` 下的 `.gml`；扩展包、`datafiles` 里的代码不索引。
- 同名符号只保留前 6 处定义（`MAX_DEFS`），避免 `x`、`i` 这类名字把索引撑爆；命中时优先当前文件。
- 只跳到**定义处**，不区分「声明」和「使用」；跳过去之后返回请用编辑器自己的返回按钮（或原路再点）。

## 实现要点（改 GMEdit 内部表时必看）

GMEdit 的 `.` 补全（`dotKind = 5`）解析类型的顺序是：

1. `parsers_linter_GmlLinter.getType(expr, editor, scope, pos)` 求表达式类型；
2. `gml_type_GmlTypeTools.getNamespace(type)` 拿到类型名；
3. 用 **`imports[scope].namespaces[类型名]`** 取成员列表。

注意第 3 步取的是**每个文件的 imports**，不是全局 `gml_GmlAPI.gmlNamespaces`。

`global.NAME` 是另一条路：`global` 在 linter 里是类型 `TInst("global",[],8)`（kind 8），
点后面的字段时查的是 **`gml_GmlAPI.gmlGlobalTypes[NAME]`**（`app.js` 里 `nsType.kind == 8` 那个分支）。
GMEdit 只会在写了 `/// @is` 的全局上填这张表，所以插件把自己算出来的形状写进去；
写完之后链路跟普通结构体完全一样（`getNamespace` → `imports[scope].namespaces[$tm.N]`）。
只有 `smartAltCompleter` / `namespaceTypeAltCompleter` 设了 `dotKindMeta = true` 才会读全局表，
主补全器 `smartCompleter` 的 `dotKindMeta` 是 `null`。

所以插件每次注入时会把合成命名空间（`$tm.N`）和占位对象命名空间**同时镜像**到
`imports[scope].namespaces`，且只写 `namespaces`，不写 `namespaceComp` / `kind`，
因此不会让 `$tm.1` 出现在普通命名空间补全里。镜像按分析代次（generation）缓存，
并且当 GMEdit 重新解析、替换了 import 对象或清空命名空间表时会自动重建。

### 为什么不会出现重复条目

`smartCompleter` 和 `smartAltCompleter` 都注册在 `editor.completers` 里，都是 `dotKind = 5`，
一次 `.` 请求会各跑一次；Ace 在 `ext-language_tools.js` 的 `getCompletions` 里把两者的结果
直接 `concat`，**不去重**。原版靠「一个查 import 表、一个查全局表」来分工，而插件把命名空间
镜像到了两张表，于是两边都命中、每个字段出现两遍。

处理方式：主补全器返回非空时记录「本次请求已应答」（用 `pos` 对象引用判定，加 200ms 时间窗
兜底），alt 补全器随即返回空数组；主补全器为空但兜底给了结果时同样记录一次。
alt 仍保留备份作用——只有主补全器完全没结果时它才会发言。

## 排错

`Ctrl+Shift+I` 打开控制台，过滤 `[typemaster]`：

- `ready (enabled=true)` —— 插件加载成功。
- `injection active: scope=xxx, vars=N, structs=M` —— 首次注入跑通了；`vars=0` 说明当前文件没分析出变量。
- `fallback supplied N field(s) for 'x.'` —— 原生弹窗为空，插件自己补的成员（功能正常，但说明内部表没命中）。
- `alt completer muted (primary already listed these fields)` —— 首次抑制 alt 补全器的重复结果，正常现象。
- `middle-click go-to-definition hooked (capture phase)` —— 中键跳转已接管（只在启动时打一次）。
- `jump to <名字> -> <路径>:<行> (<类型>)` —— 中键跳转成功；没这行说明既没解析出来、索引里也没有。
  目标是当前文件时显示 `jump to <名字> -> current buffer:<行> (<类型>)`。
- `no definition of '<名字>' on <对象>, using <另一处>` —— 接收者对象里找不到这个方法，退到了别处的同名定义。
- `__typeMaster.diag()` / `__typeMaster.diag("Open_item")` —— 一条命令看清中键链路：
  `captureHooked`（捕获监听是否装上）、`indexReady`、`definitions`、`eventMapEntries`
  （为 0 说明事件名表没加载，对象事件会索引不到）、以及某个名字是否命中、是否被当成引擎内置。
- `outline view extended: event members are listed` —— 大纲解析已接管（只在启动时打一次）。
  没有这行说明 `outline-view` 插件没启用，或者它比本插件加载得更晚（插件会重试约 8 秒）。
- `outline reindex failed, falling back:` —— 接管版本报错，已自动退回原版行为，把日志发我。
- `project index: N file(s), M function(s)..., G global(s)..., K symbol(s) with a location...` —— 索引规模，
  `G` 为 0 说明工程里没有 `global.X = ...` 形式的定义，`K` 为 0 说明定义扫描没跑。
- `global types failed:` —— 往 `gmlGlobalTypes` 写类型时出错，`global.X.` 会没有字段。
- `synchronous index build failed:` —— 中键点下去时才发现索引没建好，同步补建失败（通常是工程还没加载完）。
- `found a definition for 'X' but could not open it (consumed the click)` —— 找到了定义但打开失败，
  这次点击被吞掉（不会再跳到搜索页），把上面那行错误发我。
- `apply failed:` / `mirrorToImport` 相关 —— 注入时出错，通常说明 GMEdit 版本内部结构变了。
- 完全没有输出 —— 检查 `config.json` 是否在 `plugins/gm-typemaster/` 下，以及插件是否被禁用。
