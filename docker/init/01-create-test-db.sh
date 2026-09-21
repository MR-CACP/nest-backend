#!/bin/sh
# postgres 容器首次初始化（空数据卷）时按文件名顺序执行；
# 只负责创建 e2e 测试库 nest_test，应用自身的库由镜像环境变量 POSTGRES_DB 创建。
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	SELECT 'CREATE DATABASE nest_test OWNER "' || current_user || '"'
	WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'nest_test')\gexec
EOSQL
