/// <reference types="vite/client" />

// 引入 Vite 的客户端类型，让 import.meta.env 可用。
// 特意用三斜线引用而不是在 tsconfig 里写 "types": [...]：
// 后者会把 @types/node 等自动包含的全局声明排挤掉。
