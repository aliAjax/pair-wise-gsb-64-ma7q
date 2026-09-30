# 食品工厂HACCP控制计划与偏差处置平台

独立React前端工程，采用Fluent UI、Redux Toolkit、RTK Query、React Router、Vite和TypeScript。数据通过浏览器持久化，无需后端。

## 功能

- 生产批次、放行状态、监测点与隔离范围。
- HACCP流程图和控制矩阵编辑，记录关键限值、频率和纠偏措施。
- 偏差登记、原因与证据调查、返工/报废分支、复核退回和签字。
- 未关闭偏差阻止批次放行。
- 完整版本化审计和JSON追溯包导出。

端口为`18464`。

```bash
npm install
npm run build
npm run dev
```
