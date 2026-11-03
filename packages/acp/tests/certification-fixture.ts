import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const source = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const mode = process.argv[2];
let sessionId;
let marker;
let activePrompt;
let model="initial";
let effort="low";
const options = () => [
  ...(mode === "absent-model" ? [] : [{id:"model",name:"Model",category:"model",type:"select",currentValue:model,options:[{value:"initial",name:"Initial"},{value:"selected",name:"Selected"}]}]),
  ...(mode === "absent-effort" ? [] : [{id:"effort",name:"Effort",category:"thought_level",type:"select",currentValue:effort,options:[{value:"low",name:"Low"},{value:"high",name:"High"}]}]),
];
const send = value => process.stdout.write(JSON.stringify(value)+"\\n");
const reply = (id,result) => send({jsonrpc:"2.0",id,result});
const update = value => send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:value}});
const file = () => path.join(process.cwd(),mode === "shared" ? "fixture-shared.json" : "fixture-"+sessionId+".json");
function answer(request) {
  const {method,id,params} = request;
  if (method === "session/cancel") {
    if (activePrompt !== undefined) { reply(activePrompt,{stopReason:"cancelled"}); activePrompt=undefined; }
    return;
  }
  if (id === undefined) { return; }
  if (method === "initialize") { reply(id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}); }
  else if (method === "session/new") {
    sessionId=crypto.randomUUID();marker=undefined;
    reply(id,{sessionId,configOptions:options(),_meta:{agentSessionId:sessionId}});
  } else if (method === "session/load") {
    sessionId=params.sessionId;
    fs.readFile(file(),"utf8",(error,text) => {
      if (error) { send({jsonrpc:"2.0",id,error:{code:-32603,message:"missing controlled history"}});return; }
      marker=JSON.parse(text).marker;
      reply(id,{sessionId,configOptions:options(),_meta:{agentSessionId:sessionId}});
    });
  } else if (method === "session/set_config_option") {
    if (params.configId === "model" && mode !== "mismatch-model") { model=params.value; }
    if (params.configId === "effort" && mode !== "mismatch-effort") { effort=params.value; }
    reply(id,{configOptions:options()});
  } else if (method === "session/prompt") {
    const text=params.prompt.map(block=>block.text ?? "").join("");
    const seed=text.startsWith("seed:") ? text.slice(5) : undefined;
    if (seed !== undefined) { marker=seed; }
    const respond = () => {
      if (mode !== "no-acceptance") { update({sessionUpdate:"session_info_update",_meta:{"executablemd.session-materialization/v1":{state:"accepted"}}}); }
      if (mode === "wait") { activePrompt=id; return; }
      const value=seed !== undefined ? "READY" : mode === "lost" ? "WRONG" : marker ?? "UNKNOWN";
      update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:value}});
      reply(id,{stopReason:"end_turn"});
    };
    if (seed !== undefined) {
      fs.writeFile(file(),JSON.stringify({marker}),error=>{ if(error){throw error;} respond(); });
    } else {
      fs.readFile(file(),"utf8",(error,text)=>{ if(!error){marker=JSON.parse(text).marker;} respond(); });
    }
  } else { reply(id,{}); }
}
let buffer="";
process.stdin.on("data",chunk=>{
  buffer+=chunk;
  let index;
  while((index=buffer.indexOf("\\n"))>=0){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
    if(!line.trim()){continue;}
    const request=JSON.parse(line);
    fs.appendFile(path.join(process.cwd(),"methods.jsonl"),JSON.stringify({method:request.method})+"\\n",error=>{if(error){throw error;}answer(request);});
  }
});
`;

export interface CertificationFixture {
  dir: string;
  home: string;
  command: (mode?: string) => string;
  methods: () => Operation<string[]>;
}
export function* withCertificationFixture<T>(
  body: (fixture: CertificationFixture) => Operation<T>,
): Operation<T> {
  return yield* scoped(function* () {
    const dir = join(tmpdir(), "xmd-certification-" + randomUUID());
    yield* ensureDir(dir);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    const home = join(dir, "home");
    yield* ensureDir(home);
    const agent = join(dir, "agent.cjs");
    yield* writeTextFile(agent, source);
    return yield* body({
      dir,
      home,
      command: (mode = "normal") => "node " + JSON.stringify(agent) + " " + mode,
      *methods() {
        let text = "";
        try {
          text = yield* readTextFile(join(dir, "methods.jsonl"));
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            Reflect.get(error, "code") === "ENOENT"
          ) {
            return [];
          }
          throw error;
        }
        return text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => z.object({ method: z.string() }).parse(JSON.parse(line)).method);
      },
    });
  });
}
