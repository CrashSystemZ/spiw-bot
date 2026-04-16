import {config as loadEnv} from "dotenv"
import {z} from "zod"

loadEnv({quiet: true})

const envSchema = z.object({
    BOT_TOKEN: z.string().min(1),
    TG_API_ID: z.coerce.number().int().positive(),
    TG_API_HASH: z.string().min(1),
    DB_PATH: z.string().default("data/spiw.sqlite"),
    SESSION_PATH: z.string().default("data/mtcute.session"),
    COBALT_BASE_URL: z.string().url(),
    COBALT_AUTHORIZATION: z.string().optional(),
    COBALT_EXTRA_ENDPOINTS: z.string().default("").transform(s =>
        s.split(",").map(u => u.trim()).filter(Boolean),
    ),
    COBALT_DISCOVERY_ENABLED: z.coerce.boolean().default(true),
    COBALT_DISCOVERY_URL: z.string().url().default("https://cobalt.directory/api/working?type=api"),
    COBALT_DISCOVERY_SERVICES: z.string().default("tiktok,instagram").transform(s =>
        s.split(",").map(x => x.trim()).filter(Boolean),
    ),
    COBALT_DISCOVERY_MAX: z.coerce.number().int().positive().default(5),
    COBALT_DISCOVERY_REFRESH_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
    COBALT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    INLINE_RESOLVE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    REQUEST_TTL_SECONDS: z.coerce.number().int().positive().default(5400),
    REHYDRATE_TTL_SECONDS: z.coerce.number().int().positive().default(432000),
    METADATA_TTL_SECONDS: z.coerce.number().int().positive().default(432000),
    UI_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(432000),
    MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(32),
    MAX_FETCHES_PER_JOB: z.coerce.number().int().positive().default(4),
    MEDIA_BUFFER_BUDGET_BYTES: z.coerce.number().int().positive().default(2147483648),
    MAX_MEDIA_ITEM_BYTES: z.coerce.number().int().positive().default(2147483648),
})

export const env = envSchema.parse(process.env)
