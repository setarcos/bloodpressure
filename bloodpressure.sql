-- 血压 / 心率记录 数据库结构
-- 执行方式:
--   npx wrangler d1 execute bloodpressure --remote --file=bloodpressure.sql
--   （本地开发: npx wrangler d1 execute bloodpressure --local --file=bloodpressure.sql）

-- 用户表：用户由管理员手动预置（见 scripts/hash-password.mjs），不做注册/用户管理
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,          -- 格式: pbkdf2$迭代次数$盐(hex)$哈希(hex)
    display_name TEXT,                    -- 可选，界面上显示的名字
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 会话表：登录后发放随机 token，存 Cookie（HttpOnly）
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
);

-- 血压 / 心率记录表
CREATE TABLE bloodpressure (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    systolic INTEGER NOT NULL CHECK (systolic BETWEEN 40 AND 300),   -- 收缩压 mmHg
    diastolic INTEGER NOT NULL CHECK (diastolic BETWEEN 20 AND 200), -- 舒张压 mmHg
    heart_rate INTEGER CHECK (heart_rate BETWEEN 20 AND 250),        -- 心率 bpm，可空
    note TEXT,                                                       -- 备注，可空
    measured_at DATETIME NOT NULL,                                   -- 测量时间（UTC）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bp_user_measured ON bloodpressure (user_id, measured_at);
CREATE INDEX idx_sessions_token ON sessions (token);
CREATE INDEX idx_sessions_user ON sessions (user_id);
