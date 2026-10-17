import {createHash,randomUUID} from "node:crypto";
export function obsAuthentication(password: string, salt: string, challenge: string) {
  const hash=(value:string)=>createHash("sha256").update(value).digest("base64");
  return hash(hash(password+salt)+challenge);
}
export interface ObsConnection { request(type:string,data?:Record<string,unknown>):Promise<any>; close():void; }
export class ObsClient implements ObsConnection {
  private socket: WebSocket;
  private pending=new Map<string,{resolve:(data:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private constructor(url:string) {this.socket=new WebSocket(url);}
  static async connect(url:string,password?:string):Promise<ObsClient> {
    const parsed=new URL(url);
    if(parsed.protocol!=="ws:" || !["127.0.0.1","localhost","[::1]"].includes(parsed.hostname)) throw new Error("OBS control must use a localhost WebSocket URL");
    const client=new ObsClient(url);
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{client.close();reject(new Error("OBS connection timed out. Enable Tools → WebSocket Server Settings in OBS."));},8000);
      const fail=(message:string)=>{clearTimeout(timer);reject(new Error(message));for(const p of client.pending.values()){clearTimeout(p.timer);p.reject(new Error(message));}client.pending.clear();};
      client.socket.addEventListener("error",()=>fail("OBS connection failed. Start OBS and enable its authenticated WebSocket server."));
      client.socket.addEventListener("close",()=>fail("OBS control connection closed"));
      client.socket.addEventListener("message",event=>{
        try {
          const message=JSON.parse(String(event.data));
          if(message.op===0) {
            const auth=message.d.authentication;
            if(auth && !password) {clearTimeout(timer);client.close();reject(new Error("OBS requires a password. Use OBS_WEBSOCKET_PASSWORD or its saved local configuration."));return;}
            client.socket.send(JSON.stringify({op:1,d:{rpcVersion:1,eventSubscriptions:0,...(auth?{authentication:obsAuthentication(password!,auth.salt,auth.challenge)}:{})}}));
          } else if(message.op===2) {clearTimeout(timer);resolve();}
          else if(message.op===7) {
            const pending=client.pending.get(message.d.requestId);if(!pending)return;
            clearTimeout(pending.timer);client.pending.delete(message.d.requestId);
            if(message.d.requestStatus.result)pending.resolve(message.d.responseData || {});
            else pending.reject(new Error(`OBS ${message.d.requestType}: ${message.d.requestStatus.comment || message.d.requestStatus.code}`));
          }
        } catch(error) {fail(error instanceof Error?error.message:"Invalid OBS response");client.close();}
      });
    });
    return client;
  }
  request(type:string,data:Record<string,unknown>={}):Promise<any> {
    return new Promise((resolve,reject)=>{
      const id=randomUUID();
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`OBS ${type} timed out`));},30000);
      this.pending.set(id,{resolve,reject,timer});
      try {this.socket.send(JSON.stringify({op:6,d:{requestType:type,requestId:id,requestData:data}}));}
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  close(){this.socket.close();}
}
