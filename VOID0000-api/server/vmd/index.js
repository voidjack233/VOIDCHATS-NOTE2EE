import { createVmdRouter } from './router.js';
import { renderStoredVmdImage } from './storage.js';

export default createVmdRouter({
  renderImage: renderStoredVmdImage,
});
