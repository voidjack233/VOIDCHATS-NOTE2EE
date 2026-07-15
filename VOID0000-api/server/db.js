import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import pkg from 'pg';
import { resolvePostgresConfig } from './config/databaseConfig.js';
const { Pool } = pkg;

export const pool = new Pool(resolvePostgresConfig());
