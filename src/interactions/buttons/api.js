import { refreshStatusInteraction } from '../../commands/Core/api.js';

export default {
  name: 'api',
  async execute(interaction) {
    await refreshStatusInteraction(interaction);
  },
};
