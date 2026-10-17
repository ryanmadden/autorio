import {randomUUID} from "node:crypto";

export function nativeCommand(method:string,args:unknown[]=[]):string {
  // Long-bracket strings preserve JSON without mixing Lua and JSON escaping.
  const literal=(value:unknown)=>{
    const text=JSON.stringify(value);let equals="=";
    while(text.includes(`]${equals}]`))equals+="=";
    return `helpers.json_to_table([${equals}[${text}]${equals}])`;
  };
  return `/sc if not remote.interfaces['autorio-control'] then rcon.print(helpers.table_to_json{ok=false,status='done',error='native_control_mod_missing'}) return end; rcon.print(helpers.table_to_json(remote.call('autorio-control',${JSON.stringify(method)}${args.length?","+args.map(literal).join(","):""})))`;
}
export class NativeController {
  constructor(private command:(lua:string)=>Promise<string>,private delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))){}
  async stop(token?:string) {return JSON.parse(await this.command(nativeCommand("stop",token?[token]:[])));}
  async run(payload:Record<string,unknown>,cancelled:()=>boolean) {
    if(cancelled())return {ok:false,error:"cancelled"};
    const token=randomUUID();let finished=false;
    const began=performance.now();
    try {
      let result=JSON.parse(await this.command(nativeCommand("start",[{...payload,token}])));
      while(result.status==="running") {
        if(cancelled())return {ok:false,error:"cancelled"};
        if(performance.now()-began>600000)return {ok:false,error:"action_timeout"};
        await this.delay(100);
        if(cancelled())return {ok:false,error:"cancelled"};
        result=JSON.parse(await this.command(nativeCommand("poll",[token])));
      }
      finished=true;
      if(cancelled())return {...result,ok:false,error:"cancelled"};
      return {...result,wall_duration_ms:Math.round(performance.now()-began)};
    } finally {
      if(!finished)await this.stop(token).catch(()=>{}); // Engine lease is the fallback if RCON disconnects.
    }
  }
}
