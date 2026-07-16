import { EggCatalogItem } from './eggs.types';

export const EGG_CATALOG: EggCatalogItem[] = [
  {
    id: 'paper', eggId: 'paper', name: 'Paper', category: 'Minecraft',
    description: 'High-performance Minecraft Java server from the official Pterodactyl game-eggs catalog.',
    sourceUrl: 'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/minecraft/java/paper/egg-paper.json'
  },
  {
    id: 'fabric', eggId: 'fabric', name: 'Fabric', category: 'Minecraft',
    description: 'Fabric mod-loader server from the official Pterodactyl game-eggs catalog.',
    sourceUrl: 'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/minecraft/java/fabric/egg-fabric.json'
  },
  {
    id: 'velocity', eggId: 'velocity', name: 'Velocity', category: 'Minecraft proxy',
    description: 'Modern Minecraft proxy from the official Pterodactyl game-eggs catalog.',
    sourceUrl: 'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/minecraft/proxy/java/velocity/egg-velocity.json'
  },
  {
    id: 'vanilla-bedrock', eggId: 'vanilla-bedrock', name: 'Vanilla Bedrock', category: 'Minecraft',
    description: 'Minecraft Bedrock dedicated server from the official Pterodactyl game-eggs catalog.',
    sourceUrl: 'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/minecraft/bedrock/bedrock/egg-vanilla-bedrock.json'
  },
  {
    id: '7-days-to-die', eggId: '7-days-to-die', name: '7 Days to Die', category: 'Steam games',
    description: 'Survival sandbox dedicated server maintained by the Pterodactyl game-eggs community.',
    sourceUrl: 'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/7_days_to_die/egg-7-days-to-die.json'
  },
  {
    id: 'ark-survival-ascended', eggId: 'ark-survival-ascended', name: 'ARK: Survival Ascended', category: 'Steam games',
    description: 'ARK: Survival Ascended dedicated server maintained by the Pterodactyl game-eggs community.',
    sourceUrl: 'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/ark_survival_ascended/egg-ark-survival-ascended.json'
  },
  {
    id: 'core-keeper', eggId: 'core-keeper', name: 'Core Keeper', category: 'Steam games',
    description: 'Core Keeper sandbox server maintained by the Pterodactyl game-eggs community.',
    sourceUrl: 'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/core_keeper/egg-core-keeper.json'
  },
  {
    id: 'enshrouded', eggId: 'enshrouded', name: 'Enshrouded', category: 'Steam games',
    description: 'Enshrouded survival server maintained by the Pterodactyl game-eggs community.',
    sourceUrl: 'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/enshrouded/egg-enshrouded.json'
  },
  {
    id: 'garrys-mod', eggId: 'garrys-mod', name: "Garry's Mod", category: 'Source games',
    description: "Garry's Mod dedicated server maintained by the Pterodactyl game-eggs community.",
    sourceUrl: 'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/gmod/egg-garry-s-mod.json'
  },
  {
    id: 'palworld', eggId: 'palworld', name: 'Palworld', category: 'Steam games',
    description: 'Native Linux Palworld server maintained by the Pterodactyl game-eggs community.',
    sourceUrl: 'https://raw.githubusercontent.com/pterodactyl/game-eggs/main/palworld/egg-palworld.json'
  }
];
