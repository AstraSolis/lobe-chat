import Clear from './Clear';
import History from './History';
import InputTranslate from './InputTranslate';
import Knowledge from './Knowledge';
import Model from './Model';
import Params from './Params';
import STT from './STT';
import SaveTopic from './SaveTopic';
import Search from './Search';
import { MainToken, PortalToken } from './Token';
import Tools from './Tools';
import Typo from './Typo';
import Upload from './Upload';

export const actionMap = {
  clear: Clear,
  fileUpload: Upload,
  history: History,
  inputTranslate: InputTranslate,
  knowledgeBase: Knowledge,
  mainToken: MainToken,
  model: Model,
  params: Params,
  portalToken: PortalToken,
  saveTopic: SaveTopic,
  search: Search,
  stt: STT,
  temperature: Params,
  tools: Tools,
  typo: Typo,
} as const;

export type ActionKey = keyof typeof actionMap;

export type ActionKeys = ActionKey | ActionKey[] | '---';
