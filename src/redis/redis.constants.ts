/** ioredis 原生客户端的注入令牌（共享单连接，命令级多路复用） */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
