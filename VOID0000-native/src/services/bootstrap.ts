import type { AppBootstrap } from '../types/models';
import { apiJson } from './api';

export const fetchBootstrap = () => apiJson<AppBootstrap>('/api/bootstrap');
