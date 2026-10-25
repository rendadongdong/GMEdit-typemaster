# gm-typemaster

给 GMEdit 补上「自动类型推断」：不用写 `var x:Type`，输入 `x.` 就能列出结构体字段。

## 它做十一件事

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

4. **让 `/// @is` 对局部变量生效，并带上说明文字**
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
   `//@is`（两个斜杠）和 `///@is` 等价——GMEdit 只认三个斜杠，插件没必要跟着挑。

   **`@is` 还能带一句说明，鼠标指到变量上就会显示**（和 `///@desc` 同级待遇）：

   ```gml
   var _par_inst = inst_state.belong_inst; /// @is {obj_item_parent} 父物品的实例
   var _b = 1;                             /// @is 计数用的 {number}      （说明写在 {} 前面）
   /// @is {obj_enemy} 目标敌人
   var _target = pick_enemy();
   /// @is 只是一个说明                                                 （不写类型也行）
   var _note = 0;
   ```

   悬停时是两行：`type obj_item_parent` + `父物品的实例`。变量还没有已知类型时，就只显示说明这一行。

   - 说明写在 `{}` 之前、之后都行；`{}` 里是 `{}` 吸走的部分，剩下的文字就是说明。
   - 只写说明不写 `{}` 时**完全不影响类型推断**（不会把这句话当成类型名），只多显示一句话。
   - 说明跟着**作用域**走：同一个文件里两个函数各有一个 `_x`，各显示各自的说明；
     作用域查不到时才在全文里找，而且只有所有候选说法一致才采用（不一致就宁可不显示，免得张冠李戴）。
   - 右侧分屏（`show-aside`）的 session 是克隆的，查表会回退到主 session，所以右边悬停一样有说明。
   - 说明是按「分析代数」存的：把 `@is` 那句删掉或改掉，下一次分析就清掉旧句子，不会残留。

5. **让 `///@param {Type} 参数名` 对函数体生效**
   GMEdit 自己会解析 `@param`，但只用它来生成脚本的**参数列表**（`#args` 文档、调用处的提示），
   从来不会把它写进函数自己的作用域——所以注释明明写了类型，函数体里 `_item.` 还是一个成员都补不出来。
   插件把这条注释当**声明**处理，写进和 `/// @is` 同一张表里：

   ```gml
   ///@param {obj_item_parent} _item
   function Remove_carried_flat(_item)
   {
       _item.        // 现在会列出 obj_item_parent 的实例变量
   }
   ```

   - 三种写法都认：`@param` / `@arg` / `@argument`，`{Type}` 或 `[Type]`（GMEdit 文档里是方括号），
     一行可以写多个名字（`@param {number} _a,_b`），后面跟说明文字也没关系。
   - `{obj_xxx}` 按**对象类型**处理（会顺带把那个对象的命名空间镜像进当前 import）；
     `{number}` / `{string}` / `{bool}` / 自定义结构体名按类型名照写；
     `{obj_x[]}` 当成 `array`（数组本身没有成员可补），`{Array<obj_x>}` 只取 `Array`。
   - 带点的全限定名（GMEdit / Feather 那种写法）取**最后一段**再判断：
     `{Id.Instance.obj_item_parent}`、`{Asset.GMObject.obj_item_parent}` 都会被识别成对象类型；
     最后一段不是对象名的（`{Id.DsGrid}`、`{Struct.FontInfo}`）按原文保留，交给 GMEdit 自己解析。
   - 只认**本函数真正声明过的形参**：注释里有、形参表里没有的名字会被丢掉，
     上一函数的注释也不会串到下一个函数上——往上只认连续的 `///` 行（中间可以隔空行），
     碰到普通 `//` 注释或代码就断开。
   - 显式注记**优先级最高**：函数体里再给同名变量赋值也压不过它（`applyTo` 里参数条目排在最后）。
   - 顺带的好处：`var u = _item;` 能把参数类型传下去，`u.` 一样能补。
   - 局限：GMEdit 的「作用域」是按 `#event` / 行首 `function` 划分的。脚本里每个 `function` 各自一个作用域，
     精度最好；**对象事件**里所有方法共用一个作用域，所以同一个事件里两个方法用了同名参数、
     又注了不同类型时，后注的那个会覆盖前一个（跟 `/// @is` 的局限一样）。
   - 注记是补全时读取的，改完不用保存或重载工程，直接继续输入即可。

6. **`///@desc` 的说明跟着函数签名一起显示**
   GMEdit 会解析 `@param` / `@returns` / `@hint`，但**完全不认识 `@desc`**：那一行被 `jsDoc_anyTag`
   匹配掉，然后落进「当普通文字塞给补全列表」的分支，所以悬停提示和底部状态栏里始终只有
   `函数名(参数)`，注释里写的那句话永远看不到。

   ```gml
   ///@desc 删除物体携带的其他物体
   ///@param {obj_item_parent} _item
   function Remove_carried_flat(_item)
   ```

   现在两处都会带上它：

   - **悬停 / 补全提示**：`Remove_carried_flat(_item:obj_item_parent)` 下面多一行说明
     （`GmlFuncDoc.getAcText()` 是唯一出口，补全列表的说明栏也走这里）。
   - **底部状态栏**：`Remove_carried_flat(_item:obj_item_parent) — 删除物体携带的其他物体`，
     说明是斜体、半透明，鼠标停在上面还能看到完整两行。

   规则：

   - `@desc` / `@description` 都认；也认**裸 `///` 文字**（`/// 只是普通说明`），
     但两者同时出现时只听 `@desc`，不会把同一句话印两遍。
   - `@param` / `@returns` / `@hint` 这些标签**不会被当成说明**混进来。
   - 只认紧贴在声明上方的连续 `///` 块（中间可以隔空行），注释不会串到下一个函数上。
   - 当前打开的文件改完立刻生效（分析结果直接覆盖索引里那份），其余文件来自工程索引。
   - 名字按 `DOCS[名字]` 查，`obj.method` / `ns::fn` 会退到裸名再查一次。

   > 为什么不用 GMEdit 自己的机制：它没有 `@desc` 处理器，而签名又是 `pre + args + post`
   > 拼出来的字符串，没有任何位置能放说明。所以这里由分析器收集、在**两个显示点**追加，
   > 不去改动它内部的 doc 结构。

7. **中键点击跳转到定义**
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

8. **右侧大纲（Outline View）列出事件里的成员**
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
   - **注释掉的代码不会被列出来。** 行正则只认「这一行的掩码形式里还有没有代码」：
     `analyzer.mask()` 把注释和字符串内容替换成空格但保留长度与换行，所以整行都被注释掉时
     （`// var _old = 3;`，或者整段落在 `/* ... */` 里的旧代码）那一行的掩码是空的，直接跳过。
     `//#region` / `//#mark` 本身也是注释，它们被显式豁免，否则折叠层级会被一起清掉。
     光标定位（`updateGml`）走同一条规则，所以站在注释行上也不会把 `ctx` 认成一个树里不存在的成员
     —— 那会让"当前项"高亮找不到节点。掩码在每次 outline 更新里只算一次（缓存在 `pos` 上），
     不是每行一次。
   - 选项沿用 outline-view 自己的「显示函数参数」「滚动到顶部」，没有新增开关。
   - 代价：只有打开的标签页会被重新扫描，平均 0.6ms/文件（1.8 万行的大文件约 28ms）。
   - **分屏（右键 → Show aside）时，导航栏跟随当前聚焦的那一侧。**
     内置 outline 只认 `GmlFile.current`（永远是左边那个标签页），而 `show-aside` 是在
     文件的 session **克隆**上另建一个 Ace 实例，所以右侧换了文件、滚到别处，导航栏都毫无反应。
     插件给右侧面板准备了一个"替身文件"：原型就是真正的 `GmlFile`（`kind`、`path`、
     保存等照旧可用），只把 `codeEditor` 换成右侧的编辑器、`tabEl` 置空、`navigate` 换成
     只作用于右侧面板的定位。
     右侧一获得焦点，导航栏就切到那一份内容、高亮跟着右侧光标走；
     点导航条目只滚动右侧，不会把左边一起拖走。
     左侧重新聚焦时自动还原。
     若右侧显示的就是当前文件（`show-aside` 默认如此），两棵树内容完全一样，
     插件不会在导航栏里造第二棵重复的树，只把"当前"标记移过去，高亮仍按右侧光标算；
     只有左右打开的是**不同文件**时，才会多出一棵名字带 ` (aside)` 的树。
     焦点探测来自 `#aside_editor` 里实际获得焦点的元素，700ms 轮询 + `focus` 事件双保险。
   - **右侧面板有自己的标签栏（VS Code 双编辑组那种）。**
     `show-aside` 的 `show()` 只在打开那一刻克隆一次当前文件，之后没有任何换文件的入口
     （它自己的 `gmlFile`/`session` 是闭包私有的），而主标签栏只代表左边那一组。
     所以插件在 `#aside_editor` 顶部插了一条自己的标签栏（`.tm-aside-tabs`）：
     列出**在右侧打开过**的文件，点哪一项就 `aceTools.cloneSession` 给右侧重建克隆，
     左侧的标签、内容、焦点完全不动；`×` 关闭该项；中键也能关；`#aside_editor` 本身就是
     `.ace_container{display:flex;flex-direction:column}` + `.ace_editor{flex-grow:1}`，
     所以这条 26px 的栏只是占走自己的高度，编辑器自动让位，不需要动布局。
     关掉**最后一个**标签时，右侧面板跟着一起关（跟 VS Code 里关掉编辑组的最后一个标签一样）：
     面板是 `show-aside` 的，而它的 `hide()` 在闭包里（交给 `GMEdit.register` 的对象只有
     `init`/`cleanup`，`plugins_PluginManager.stop` 会把插件标成未初始化、下次启动再插一条
     「Show aside」），所以插件去点它自己在侧栏右键菜单里加的那条 **Hide aside**。
     自己删 DOM 是不行的：那样插件的 `gmlFile` 还留着，而它的 `show()` 里有
     `if (gmlFile == file) return;`，面板就再也打不开了。
     顺手先把 outline 交还左侧（`unpinAside`），等 `#aside_editor` 没了就没机会了。
     主标签栏因此**恢复原生行为**：插件不再在它上面挂任何监听，点它只切左边。
     要把某个文件放进右侧：右键主标签页 → **Open in aside pane**
     （走 GMEdit 自己的 `tabMenu` 信号 + `Electron_MenuItem`，右侧没开时会先替你按
     「Show aside」把它打开）。
     点标签栏里的项时，`mousedown` 的默认行为会先把焦点从编辑器上挪走，所以切换后要
     `ed.focus()` 把焦点还回右侧，否则 700ms 后右侧会被判成「未激活」。
     关掉分屏后列表清空，下次打开从当时显示的文件重新开始。
   - **右侧能正常输入的原因**：`cloneSession` 与左侧共享同一个 `document`、也共享同一个
     `gmlEditor`（也就是同一张 `imports` / `locals` 表），所以左侧已经注入过的类型对右侧
     天然有效。以前每次在右侧敲键都重跑一遍分析 + 全量重建 `$tm.N` 命名空间，两边的分析缓存
     还会互相顶掉（缓存只有一个槽位），在大对象文件里就表现为「敲一两个字母就卡住」。
     现在 `needsInjection()` 对同一个文档的克隆直接跳过，右侧输入不再触发任何分析；
     分析缓存也改成每个 session 各一份（`WeakMap` + 文本指纹）。

9. **`global.NAME` 的结构体字段**
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

   **字段能带说明，鼠标停在字段上就显示。** GMEdit 对 `field` / `localfield` 这两种
   token 的处理是「只查文档、不设类型」，结果就是**什么都不弹**（`AceTooltips.update` 里
   那个 `canDocData` 分支只把 `ctx.docs = {}`）。插件把说明登记在自己的表里，
   在原生 `update()` 结束后补一句，于是悬停时能看到「类型 + 一句话」：

   ```gml
   global.DATA_STRUCT =
   {
       PLACE_FROM_STORAGE : false, ///@is {bool} 是否允许从仓库取出
       CLICK_INST : noone,         //最近点击的实例（物体）
       /// @type {Id.SpriteElement} 准备要放置物体的 小图标 sprite_index
       SPRITE : -1,
   }

   global.DATA_STRUCT.PLACE_FROM_STORAGE   // 悬停 -> type bool / 是否允许从仓库取出
   global.DATA_STRUCT.CLICK_INST           // 悬停 -> 最近点击的实例（物体）
   ```

   - 三种写法：同行 `///@is {T} 说明`、同行 `//说明`、**字段上一行**的 `///@is` / `/// @type`
     （`@type` 是 GMEdit 自己的字段注记，很多人已经在用）。`//@is` 两个斜杠同样认。
   - `{T}` 里的类型**只用于显示**：`noone`、`null` 这类推断不出名字的值靠它才有一行 `type ...`；
     结构体递归（`global.X.a.b.`）仍然走推断出来的真实类型，不会被注记带偏。
   - 说明按**路径**存（`DATA_STRUCT.WILL_PLACE_DATA.SPRITE`），另外登记一份裸字段名，
     好让 `var _cfg = global.DATA_STRUCT; _cfg.CLICK_INST` 这种别名也查得到。查表顺序是
     「整条路径 → 限定符逐段削减 → 裸名」，路径永远优先——两个结构体可以有同名字段。
   - 同名不同说明时**不猜**：该名字标成歧义，宁可不显示也不显示错的那句。
     工程索引里也是一样（先扫到的赢，之后任何文件报歧义都会把这条标成歧义）。
   - 只认出**紧跟在字段后面**的注释：同一行有两个字段时，注释算后一个的；
     嵌套结构里的注释算最内层字段的（`DEEP: { X : 1, //x 的说明` 归 `X`）。
   - 字段上一行的**普通 `//` 注释不算说明**——那种位置十有八九是分节标题，硬套上去会让半个
     结构体的字段都挂上同一个标题。要写说明请用同行的 `//`，或上一行带 `@is` / `@type`。
   - 字符串里的 `//`（`"http://x"`）不会被当成注释开头。
   - 字段值是 sprite 资源时，原生弹的是缩略图（`setHtml`），这种情况不追加说明——改写文字会把图片冲掉。

10. **构造函数里的成员也能标注类型和说明**
    `function Item() constructor { hp = 10; ... }` 里的 `hp` 是**实例成员**，不是局部变量。
    GMEdit 会把它们记进这个构造函数的命名空间（所以 `item.` 能列出来），但**悬停时一个字都不显示**，
    你自己写的注释也完全没人看。插件补上这一层：

    ```gml
    function Item(_name) constructor
    {
        hp = 10;                    ///@is {number} 生命值
        name = _name;               //名字
        bag =
        {
            slots : [],             //格子数组
            count : 0,              ///@is {number} 已用格子数
        };
        /// @is {obj_item_parent} 主人
        owner = noone;
        var tmp = 0;                //临时变量：这是局部变量，不是成员
    }
    ```

    悬停 `hp`（构造函数体内）→ `type number` + `生命值`；悬停别处的 `item.hp` / `self.hp` 也一样。

    - 三种写法都认：同行 `///@is {T} 说明`、同行 `//说明`、**上一行**的 `///@is` / `/// @type`。
      `//@is`（两个斜杠）也认——GMEdit 只认三个斜杠，插件没必要跟着挑。
    - **只有裸赋值算成员**：`hp = 10` 是成员，`var tmp = 0` 是局部变量（它照样能带说明，按作用域查）。
      先 `var _v;` 声明、后来再 `_v = 1;` 赋值的，仍然算局部变量。
    - 嵌在 `if` / `for` 块里的成员赋值算成员；嵌在 `f = function () { ... }` 里的**不算**（那是另一个作用域）。
    - 成员里的结构体（`bag = { slots : [] }`）按路径登记 `bag.slots`，和 `global.X` 的结构体字段同一条链路。
    - 继承写法 `function Sub() : Parent() constructor`、赋值式 `Item = function () constructor`、
      `static` 成员都支持。
    - 查得到的前提是**名字能对上**：`item.hp` 走「路径 → 裸名」，所以两个构造函数都写了 `hp`、
      但说明不同时，裸名会被标成歧义而**不显示**（`A.hp` / `B.hp` 各自仍然有效）。
    - `x` / `y` / `name` / `image_index` 这类**内置实例变量不做裸名登记**：否则任何 `别的.x`
      都会被挂上某个人给 `x` 写的说明。`Item.x` 这种带构造函数名的路径不受影响。

11. **树面板标题栏的「全部重新读取」按钮**
    GMEdit 只在**切到某个标签时**才检查那一个文件有没有被外部改过（默认设置下还会弹窗问
    "Reload file / Keep current / Open changes in a new tab"）。如果文件是别的工具改的
    —— 另一个编辑器、生成器、批处理脚本 —— 那就意味着把每个标签点一遍、把同一个问题回答一遍。

    工程树标题栏、☰ 左边多了一个 ⟳ 按钮，点一下把所有打开的文件从磁盘重读一遍，一个弹窗都不出：

    - 走的是 GMEdit 自己确认"重新加载"时的同一条路：`EditCode.load()` 读盘 → 替换缓冲区 →
      `savePost_shared(code, true)` 重新索引 → 同步 `file.time`。所以重载过的标签之后
      **不会再弹**那个"文件已改变"的提醒。
    - **有未保存改动的标签不动**。"文件在外面被改了"和"我正准备丢掉你敲的东西"是两件事，
      按钮只负责前一件；按住 **Shift 点击**会把它们也一起重载。
    - 磁盘内容没变时只同步时间戳，不碰缓冲区——撤销历史、折叠、光标都留着（原生那条确认路径
      是会把这些冲掉的）。真的要换文本时，也会把光标和滚动位置放回去（行号超出就夹到最后一行）。
    - 比较的是**归一化之后**的文本（去掉 `\r`、去掉结尾空白），只是换了换行符的工具不会触发
      一次没必要的重载。
    - 非代码标签（精灵/字体/对象编辑器）走它们自己的 `checkChanges()`，那条路本来就不弹窗。
    - 右侧分屏（Show aside）里那个文件即使已经从主标签栏关掉，也会一起重载：`show-aside`
      克隆的是**同一个 doc**，所以主 session 一换文字，右面板跟着变。
    - 结果在左下角提示一行、2.6 秒后淡出：`Reloaded 5 files`、
      `Reloaded 3 files · 2 kept: unsaved edits (Shift+click forces)`、`No open file changed on disk`。
    - **有变化时按钮上会亮一个绿点**（图标左上角）：至少有一个打开的文件，磁盘上的内容和
      缓冲区"已知版本"不一致。判定**不用 `mtime > file.time`**（GMEdit 自己的做法）：`file.time`
      在每次聚焦时就被 `checkChanges` 先改成新 mtime 了——包括你回答「Keep current」的那次，
      于是你正在看的那个标签永远判不出"变了"。插件自己记一份**内容基线**（路径 →
      `{mtime, sig}`，`sig` 是归一化后文本的 djb2 哈希 + 长度），`mtime` 只当便宜的预筛，
      变了才读内容比对签名；只动 mtime、内容没变的（CRLF 翻转、工具重写同内容）不算变化。
      每 1.5 秒看一次（只跳过 `document.hidden`，最小化那种后台；**不看 `document.hasFocus()`**——
      Electron 在 devtools 或系统对话框拿到焦点时会返回 false，那种"轮询悄悄停了"正是绿点不亮的
      根因之一），窗口重新拿到焦点时再补一次；tooltip 里会写清有几个文件变了。点完按钮、文件重读
      之后绿点自己灭；被跳过的脏文件会让它继续亮着——那是"确实还有东西没处理"，不是漏了。
    - 圆点本身是个**真实节点**（`<i class="tm-dot">`，几何与颜色都写进行内样式），不是 CSS
      的 `::after`：这样即使 `styles.css` 没加载、或选择器哪天不匹配了，圆点照样能显示出来。
      样式表里那几条规则只是兜底。
    - 基线还会跟着 GMEdit 自己的 `fileSave` / `fileReload` 信号刷新：你在它弹的框里选
      「Reload file」之后，那个标签不会留下一个骗人的绿点。
    - 「Keep current」留下的旧副本能靠基线认出来（内容 == 上一版磁盘内容），所以它**不算脏**，
      点按钮会直接换成新内容——这正是这个按钮存在的理由：不用真的丢掉未保存的改动。
    - 命令面板里还有两条：
      - `TypeMaster: Reload all open files from disk`
      - `TypeMaster: Check the green dot (writes diag.json)` —— 立刻重算一遍并把自检写进
        `plugins/gm-typemaster/diag.json`，左下角提示一行摘要。**绿点不亮时先跑这条**：
        文件里的 `build` 说明当前跑的是哪一版代码，`files[]` 每一行是一个标签的
        `mtime / baseMtime / diskSig / bufferSig / changed`，`lastError` 是最近一次被吞掉的异常。

    这个按钮**不受** Preferences 里那个类型推断开关影响——它是编辑器小工具，关掉推断不该
    把重载也一起关掉（只有整个插件停用才会移除）。

## 安装 / 生效

插件目录：`%APPDATA%\AceGM\GMEdit\plugins\gm-typemaster\`

- **改了 `main.js`（或新装插件）后，`Ctrl+R` 是不够的**：`Ctrl+R` 是 `reloadProject`，
  只重载 GameMaker 工程，插件代码还是内存里那份。要用下面任一种方式让插件从磁盘重新读：
  - 命令面板（`Ctrl+Shift+P`）→ `Reload GMEdit`（内部是 `document.location.reload()`），
  - `Preferences → 其他有用功能 → Reload GMEdit`，
  - 或者干脆退出 GMEdit 再打开。

  判断有没有生效：`ctrl+shift+p` 里能看到 `TypeMaster: Check the green dot` 这条新命令，
  或者看 `%APPDATA%\AceGM\GMEdit\plugins\gm-typemaster\diag.json` 里的 `build` 戳。
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

命令面板里还有四个：

- `TypeMaster: Refresh inferred types` —— 清缓存强制重算。
- `TypeMaster: Reload all open files from disk` —— 等价于点树面板标题栏的 ⟳ 按钮
  （不会重载有未保存改动的标签；按钮上按住 Shift 点击才会）。
- `TypeMaster: Check the green dot (writes diag.json)` —— 立刻重算绿点并写自检文件，
  左下角给一行摘要；绿点不亮时先跑这条。也可以在控制台执行 `__typeMaster.dot()`。
- `TypeMaster: Debug dump (console)` —— 把当前作用域、已注入的变量类型、import 里的命名空间、分析出的结构体数量打印到控制台；也可以直接在控制台执行 `__typeMaster.dump()`。
  `vars` 里每行形如 `_item@3 -> obj_item_parent`（名字@行号 -> 类型）：`///@param` 有没有被认出来，
  看这里有没有对应的一行就知道。
  顶层字段里 `documentedFunctions` 是收集到的 `///@desc` 条数，`documentedFields` 是收集到的
  结构体字段说明条数（含路径键与裸名键，歧义条目也在里面），`funcDocHook` / `statusBarHook` /
  `tooltipHook` 是三个追加点（函数说明的签名出口、状态栏、变量/字段悬停）有没有装上，
  `reloadAllButton` / `openTabs` 是标题栏那颗 ⟳ 有没有挂上去、以及主标签栏一共开着几个标签，
  `changedOnDisk` 是绿点当前显示的数目，`diskWatch` 是绿点的内部状态（`build` 当前版本戳、
  `polling` 轮询在跑、`baselines` 记了几个基线、`signalsHooked` 是否挂上了 `fileSave`/`fileReload`、
  `mtimeFailures` 上一轮读不到 mtime 的次数——这个数字等于打开的文件数时，绿点不可能亮，
  日志里也会有一行说明；还有 `dotInDom` / `diagPath` / `lastError`）。

## 工程索引（跨文件函数返回值）

插件启动后约 0.8 秒会在后台扫描工程（只读，不改任何文件）：

- 范围：`<工程目录>/scripts/**` 和 `objects/**` 里的 `.gml`，跳过 `tmp`。
- 记录：每个 `function name(...) { ... return ... }`，以及 `scripts/` 里 `name = function(...) {...}`
  的**第一个** `return` 形状（对象事件里的赋值式函数是实例方法，不入索引）。
- 同时记录 `global.NAME = ...` 的值形状（跨文件的 `global.X.` 靠它）。
- 同时记录**结构体字段的说明**（`///@is {T} 说明`、同行 `//说明`、上一行的 `@type`），跨文件悬停才显示得出来。
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
- 结构体字段的说明只认**同行尾注释**（或上一行的 `@is` / `@type`）。写在字段**上方且不带标签**的
  `//` 不算——那更像分节标题。注释在一行里的归属按「紧跟谁」判断，一行塞多个字段时只有一个能拿到。
- 字段注记里的 `{T}` 只影响**悬停显示**，不参与类型解析：写了 `///@is {obj_enemy}` 之后，
  `X.field.` 的补全仍然按真实推断走（推不出来就还是不列成员）。
- 构造函数成员也按**名字**匹配，不做「这是哪个类的实例」的类型推导：`item.hp` 能显示，是因为
  全工程只有一处给 `hp` 写了说明。两个类各写了不同说明时，裸名 `hp` 就不显示（`A.hp` 这类
  带类名的路径仍然有效）。
- 一行里写 `var a = 1, b = 2;` 时只有 `a` 会被当成声明，`b` 后面的说明仍然挂在 `b` 上，
  但 `b` 不会被记成「由 `var` 声明」，极端情况下会被构造函数当成成员。分行写即可避免。
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

### 分屏为什么能跟随（以及为什么不能直接改 `GmlFile.current`）

`outline-view` 内部取"当前文件"只有一条路：`currFile()` → `gml.file.GmlFile.current`。
`show-aside` 建第二个 Ace 实例时用的是 `aceTools.cloneSession(file.codeEditor.session)`，
克隆 session 上挂的 `gmlFile` 仍是**同一个** `GmlFile`，所以：

- 右侧的 session 是独立的（滚动、光标各走各的），但"这是哪个文件"没有第二份登记；
- 于是导航栏永远解析左边那份。

诱人但危险的做法是把 `GmlFile.current` 劫持成右侧的替身——保存、lint、标签高亮、`checkChanges`
都会跟着读到替身，容易出错。插件用的是另一条路：

1. 做一个 `Object.create(真file)` 的替身，只覆盖 `codeEditor` / `name` / `tabEl` / `navigate`；
2. 右侧拿到焦点时，通过 `plugins.PluginAPI._signal("activeFileChange", { file: 替身 })`
   触发 outline 自己的 `changeTo` → `createFor` → `reindex`，走的还是**同一套**解析代码
   （`_modeMap["ace/mode/gml"]` 已经被本插件接管），只是 `file.codeEditor` 换成了右侧的；
3. `displayMode` 不是"只显示当前文档"时，outline 的 `syncAll` 不会把替身放进树里，
   插件再把它手动挂回 `#outline-view .treeview` 并打上 `outline-current-file`；
   若右侧就是当前文件，则跳过 1–3：两棵树长得一模一样，复用左边那棵，只移动当前标记；
4. 高亮跟随：outline 只监听主编辑器的 `changeSelection`，所以右侧改选时插件对主编辑器
   `_emit("changeSelection")` 空推一次，`updateGml` 里再用 `paneDocRow()` 换成右侧的
   doc 与光标行——`pos.def` / `pos.ctx` 算的是右侧的位置，DOM 里查的却是当前高亮的那棵树，
   两边正好对上。**但只能换第一次**：`outline-view` 的 `update()` 在 `pos.ctx` 找不到对应
   条目时会用一个没有次数上限的 `while` 逐行往上回溯（`pos.row -= 1` 后重新调用
   `modeMap.update`），完全依赖 `pos.row` 递减到负。若每次都拿右侧光标行覆盖它，回溯就永远
   退不出去，整个 GMEdit 会锁死（窗口还在重绘光标，但主线程已死，点哪都没反应）。
   所以 `updateGml` 现在的约定是：只在 `pos.def` / `pos.ctx` 都还为空（= 一轮更新的第一次
   调用）时用面板光标，之后**必须**用调用方传进来的 `pos.row`，并保证每次返回的行号严格小于
   传入的行号；另有 2000 次调用的硬上限兜底；
5. 点条目不能走原生 `kind.navigate`——它内部硬编码 `Main.aceEditor.gotoLine`，会把左边拖走。
   替身的 `navigate` 自己按 `nav.def` / `nav.ctx(Rx)` 找行，只在右侧 `gotoLine`。

### 为什么不会出现重复条目

`smartCompleter` 和 `smartAltCompleter` 都注册在 `editor.completers` 里，都是 `dotKind = 5`，
一次 `.` 请求会各跑一次；Ace 在 `ext-language_tools.js` 的 `getCompletions` 里把两者的结果
直接 `concat`，**不去重**。原版靠「一个查 import 表、一个查全局表」来分工，而插件把命名空间
镜像到了两张表，于是两边都命中、每个字段出现两遍。

处理方式：主补全器返回非空时记录「本次请求已应答」（用 `pos` 对象引用判定，加 200ms 时间窗
兜底），alt 补全器随即返回空数组；主补全器为空但兜底给了结果时同样记录一次。
alt 仍保留备份作用——只有主补全器完全没结果时它才会发言。

### 「全部重新读取」按钮挂在哪、为什么能免掉弹窗

按钮本身只是往 `#tree-td > .chrome-tabs.project-name > .system-buttons` 里 `insertBefore`
了一个 `<span class="system-button">`（`#index.html` 里那个已经有 ☰ 的盒子），所以尺寸、
hover 底色、和主题的适配全是照抄 `.system-button` 的，没有自绘样式。标题 `#project-name`
原本是 `calc(100% - 28px)`（给一个 36px 按钮留 28px），多一格就用
`.tm-has-reload` 把它改成 `calc(100% - 64px)`。

免弹窗的关键在 `GmlFile.focus()` → `checkChanges()` → **`file_kind.KCode.checkForChanges()`**：
它只比较 `Electron_FS.statSync(path).mtimeMs` 与 **`file.time`**，`> file.time` 才认为变了。
而 `EditCode.load()` 里末尾就有 `this.file.syncTime()`，会把这个时间戳写回去。于是：

- 重载过的标签：`file.time` 已是新的，`checkForChanges` 返回 0，不会再问；
- 没重载的标签（有未保存改动）：**故意不调用 `load()`**，时间戳保持旧值，原生那条"文件冲突"
  弹窗依旧会在切过去时出现——这是保留的逃生口，不是漏掉的分支。

另外 `AceTooltips`/`bgTokenizer` 之类不参与：`session.setValue()` 之后 Ace 自己会重新标记，
`markClean()` 再把撤销管理器的干净位置挪到当前（否则状态栏下一次 `set_changed()` 会给标签
点上一个假的"未保存"圆点）。

绿点的判定**不能**用上面那条 `mtime > file.time`：`file.time` 会在每次聚焦时被 GMEdit 自己
先改成新 mtime——`GmlFile.focus()` 无条件跑 `checkChanges()`（另外 `ui.ChromeTabs.init` 之后
它还挂了一个 `window focus` 监听，对当前文件再跑一次），而 `checkChanges` 在**弹框之前**就
`file.time = time1` 了，回答「Keep current」也一样。结果就是：你正在看的那个标签永远判不出
"变了"，绿点永远不亮。所以这里记的是一份自己的**内容基线**：

- `DISK_BASE[path] = { mtime, sig, prevSig, prevMtime }`，`sig = djb2(normCode(文本)) + ":" + 长度`；
- `mtime` 只当便宜的预筛，变了才 `readContent()` 比 `sig`——只动 mtime、内容没变的
  （CRLF 翻转、工具重写同内容）直接回写 `mtime` 并判"没变"；
- 基线在四个时刻刷新：第一次见到文件、按钮重载完一个文件、GMEdit 的 `fileSave`、`fileReload`；
- `prevSig` 记住"上一版磁盘内容"，`bufferIsOldDisk()` 用它认出「Keep current」留下的旧副本，
  这种缓冲区不算脏，可以直接覆盖——真正在打字的内容不是任何一版磁盘内容，所以还是被拦住；
- 万一 `mtime` 一个都读不到（`Electron_FS` 拿不到），`DISK_STAT_FAIL` 会在日志里明说
  "the green dot cannot work"，而不是安静地什么都不显示。

绿点本身走的是**轮询**而不是 `fs.watch`：一个 GMS 工程意味着每个文件一个 watcher，IDE 一保存就是
一串事件，而这个信号只要"差不多及时"就够了。`statSync` × 打开的文件数，1.5 秒一次，代价可以忽略；
只有 `document.hidden`（最小化/完全被遮住）时整个跳过，`window.focus` 时补一次。状态记在
`RELOAD_COUNT` 里，并且每次都重新读一遍 class 本身——这样即使别的什么把 class 抹掉了，下一轮
也会自己长回来。

这条判断链路（stat → 读文件 → 比签名 → 切 class → 画圆点）每一步都可能是"静默失败"，
所以它同时往 `plugins/gm-typemaster/diag.json` 写自检：见上面「Check the green dot」那条命令。
文件里的 `build` 戳一眼就能区分"逻辑错了"和"插件根本没重载"这两件完全不同的事。

## 排错

`Ctrl+Shift+I` 打开控制台，过滤 `[typemaster]`：

- `ready (enabled=true, build=dot-...)` —— 插件加载成功。**`build` 是重点**：它跟
  `README`/`main.js` 里的一致才说明新代码真的进来了。只按过 `Ctrl+R` 的话这里还是旧戳，
  因为 `Ctrl+R` 只重载工程（见上面「安装 / 生效」）。
- `diag.json` 的 `build` 和当前版本不一致，或者文件根本不存在 —— 说明插件没被重载过。
- `diag.json` 里 `openFiles` 是 0、而 GMEdit 明明开着文件 —— 那些标签从没被点开过，
  `tabEl.gmlFile` 还没挂上（GMEdit 只在标签第一次激活时建立这个关联）；点一下标签就有了。
- `diag.json` 里 `files[].mtime` 是 0 —— `Electron_FS.statSync` 这条路不通，绿点不可能亮。
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
- `aside pane hooked: the outline follows the focused pane` —— 第一次检测到分屏（Show aside）
  面板时打一次。之后用 `__typeMaster.dump()` 里的 `aside` 字段看状态：
  `detected`（有没有分屏）、`focused`（焦点是否在右侧）、`file`（右侧显示的文件）、
  `base`（右侧克隆自哪个文件）、`sharedDoc`（是否和左侧同一份文档）、`tabs`（右侧标签栏里
  有几项）、`tabsShown`（那条栏是否真挂在页面上）、`tabMenu`（`Open in aside pane` 是否已装上）、
  `dirty`（内容改过、下次聚焦会重建）、`reusedTree`（是否复用左侧那棵树）。
- `aside: clicking a tab now switches the right pane` —— 标签栏的换文件监听装上了（一次）。
- `aside pane switched to X` —— 右侧换到了 `X`。
- `aside: could not close the right pane` —— 关掉右侧最后一个标签时没能把面板关上：
  正常情况下找不到那条 `Hide aside` 才会出现（只在面板已开时才成立，出现就说明版本又变了）。
- `aside unpin failed:` / `aside hide failed:` —— 关面板途中出错，面板可能还留在原地。
- `aside switch failed:` / `aceTools.cloneSession is unavailable` —— 右侧换文件失败，
  这一步依赖 GMEdit 自己的 `aceTools.cloneSession`，版本差异时可能没有。
- `signal 'activeFileChange' failed:` —— 通知 outline 切换文件时出错，导航栏不会跟随右侧。
- `aside navigate failed:` —— 点导航条目时在右侧定位失败（不会影响左侧）。
- `outline reindex failed, falling back:` —— 接管版本报错，已自动退回原版行为，把日志发我。
- `project index: N file(s), M function(s)..., G global(s)..., K symbol(s) with a location...` —— 索引规模，
  `G` 为 0 说明工程里没有 `global.X = ...` 形式的定义，`K` 为 0 说明定义扫描没跑。
- `global types failed:` —— 往 `gmlGlobalTypes` 写类型时出错，`global.X.` 会没有字段。
- `synchronous index build failed:` —— 中键点下去时才发现索引没建好，同步补建失败（通常是工程还没加载完）。
- `reload-all (safe|force): N reloaded, M unchanged, K skipped, J missing` —— 点了一次 ⟳ 之后的结果。
- `change detection: could not read mtime of any open file` —— 绿点不可能亮的唯一原因：
  `Electron_FS.statSync` 这条路走不通。带上这一行报错即可定位。
- `found a definition for 'X' but could not open it (consumed the click)` —— 找到了定义但打开失败，
  这次点击被吞掉（不会再跳到搜索页），把上面那行错误发我。
- `apply failed:` / `mirrorToImport` 相关 —— 注入时出错，通常说明 GMEdit 版本内部结构变了。
- 完全没有输出 —— 检查 `config.json` 是否在 `plugins/gm-typemaster/` 下，以及插件是否被禁用。
