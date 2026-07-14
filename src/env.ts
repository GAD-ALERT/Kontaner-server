import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_ROUNDS: z.coerce.number().default(10),

  DATABASE_URL: z.string().url(),

  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  GEMINI_API_KEY: z.string().min(1),

  GMAIL_SMTP_USER: z.string().email().optional(),
  GMAIL_SMTP_APP_PASSWORD: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().optional(),
  APP_URL: z.string().url().default('http://localhost:5173'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    '\n❌ Invalid environment variables:\n' +
      parsed.error.issues
        .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
        .join('\n') +
      '\n\n  Copy .env.example → .env and fill in the values.\n',
  );
  process.exit(1);
}

export const env = parsed.data;
