import dotenv from 'dotenv';
import { fromProjectRoot } from './config/projectRoot.js';

dotenv.config({ path: fromProjectRoot('.env') });

import pkg from 'pg';
import { resolvePostgresConfig } from './config/databaseConfig.js';
const { Pool } = pkg;

export const pool = new Pool(resolvePostgresConfig());
