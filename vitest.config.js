import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
    test: {
        poolOptions: {
            workers: {
                // 单测试文件内共享 D1 存储（默认 isolatedStorage: true 会让
                // 每个测试拥有独立存储快照，测试间写入不共享）。
                // 参考 https://developers.cloudflare.com/workers/testing/vitest-integration/isolate-storage/
                isolatedStorage: false,
                wrangler: { configPath: './wrangler.jsonc' },
            },
        },
    },
});
