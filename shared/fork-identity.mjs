import { homedir } from 'node:os'
import { resolve } from 'node:path'

export const FORK_PRODUCT_NAME = 'Qwen Audio Agent TubeLiu'
export const FORK_PACKAGE_NAME = 'qwen-audio-agent-tubeliu'
export const FORK_APP_ID = 'ai.qwenaudio.agent.tubeliu'
export const FORK_PROTOCOL = 'qwaudio-tubeliu'

export function forkConfigDirectory(env = process.env, homeDirectory = homedir()) {
  return env.QWAUDIO_CONFIG_DIR ? resolve(env.QWAUDIO_CONFIG_DIR)
    : resolve(env.XDG_CONFIG_HOME || resolve(homeDirectory, '.config'), 'qwaudio-tubeliu')
}
