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
