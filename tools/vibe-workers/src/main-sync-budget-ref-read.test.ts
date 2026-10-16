import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBudgetRefs, type BudgetRefCapture, type UnprovedBudgetFallback, type ProvedBudgetCompletion } from "./main-sync-budget-ref-read.js";
import { bindCheckBudgets, affectedTestReportSelection } from "./main-sync-budget.js";
import { checkRecipe } from "./main-sync-checks.js";
import { mainSyncReceiptSchema, type MainSyncReceipt } from "./main-sync-contracts.js";
import { syncContext } from "./main-sync-state.js";
import { syncFixture, invokeSync, installAffectedTestWrapper } from "./main-sync-test-fixtures.js";
import { comparisonBudgetMs } from "./main-sync-validation-recipe.js";

const control=vi.hoisted(()=>({calls:[] as string[][],reply:undefined as undefined|((root:string,args:string[])=>string|undefined)}));
vi.mock("../../../plugins/vibe/skills/vibe/scripts/session-record.mjs",async importOriginal=>{
  const actual=await importOriginal<typeof import("../../../plugins/vibe/skills/vibe/scripts/session-record.mjs")>();
  return {...actual,git:(root:string,args:string[],options?:{timeout?:number})=>{
    control.calls.push([...args]); const value=control.reply?.(root,args);
    return value===undefined ? actual.git(root,args,options) : value;
  }};
});
const fixtures:ReturnType<typeof syncFixture>[]=[];
const restorers:(()=>void)[]=[];
const a="a".repeat(40),b="b".repeat(40),m="c".repeat(40);
const pair=["rev-parse","HEAD","origin/main"],head=["rev-parse","HEAD"],main=["rev-parse","origin/main"];
afterEach(()=>{control.reply=undefined;control.calls.length=0;vi.restoreAllMocks();for(const restore of restorers.splice(0))restore();for(const value of fixtures.splice(0))value.cleanup();});

describe("fixed budget refs and actual budget caller",()=>{
  it("reads exact successful pair once",()=>{
    install((_,args)=>{expect(args).toEqual(pair);return `${a}\n${m}`;});
    expect(readBudgetRefs("/owned/root")).toEqual({head:a,main:m});expect(control.calls).toEqual([pair]);
  });
  it.each(["malformed","extra","faithful-error"])("retains proved B through %s second field, never later A",kind=>{
    install((_,args)=>{if(same(args,pair)){if(kind==="faithful-error")throw failed(`${b}\n`);return `${b}\n${kind==="extra"?`${m}\nextra`:"origin/main"}`;}if(same(args,head))return a;return m;});
    expect(readBudgetRefs("/owned/root")).toEqual({head:b,main:m});expect(control.calls).toEqual([pair,main]);
  });
  it.each(["empty","nonterminated","wrong-error","plain-error"])("only %s unproved first uses original fallback",kind=>{
    install((_,args)=>{if(same(args,pair)){if(kind==="wrong-error")throw new Error("unrelated");if(kind==="plain-error")throw {stdout:`${b}\n`};return kind==="empty"?"":b;}return same(args,head)?a:m;});
    expect(readBudgetRefs("/owned/root")).toEqual({head:a,main:m});expect(control.calls).toEqual([pair,head,main]);
  });
  it.each(["unproved-head","unproved-main","proved-main"])("propagates original %s failure priority",kind=>{
    const error=new Error(kind);install((_,args)=>{if(same(args,pair)){if(kind==="proved-main")throw failed(`${b}\n`);return "HEAD\norigin/main";}if(same(args,head)){if(kind==="unproved-head")throw error;return a;}throw error;});
    expect(()=>readBudgetRefs("/owned/root")).toThrow(error);
    expect(control.calls).toEqual(kind==="unproved-head"?[pair,head]:kind==="proved-main"?[pair,main]:[pair,head,main]);
  });
  it("binds real repeated affected and pinned keys, with unchanged post refs and fields",()=>{
    const value=setup();withPath(value);const receipt=syntheticReceipt(value);installAffectedWrapper(value);
    const commands=[{argv:["pnpm","test:affected","--continue"]},{argv:["pnpm","test:affected"]},
      {argv:["pnpm","turbo","test",`--filter=...[${receipt.validationSince}]`]}];
    control.calls.length=0;const bound=bindCheckBudgets(value.worktree,receipt,commands);
    expect(bound.map(x=>x.argv)).toEqual(commands.map(x=>x.argv));
    expect(bound.map(x=>x.timeoutMs)).toEqual([66*60*1000,66*60*1000,66*60*1000]);
    expect(control.calls.filter(x=>same(x,pair))).toHaveLength(2);
    expect(control.calls.filter(x=>same(x,head))).toHaveLength(2);
    // operator ruling, 2026-10-16: no post-selection origin/main read; the selection is pinned to the captured mainSha.
    expect(control.calls.filter(x=>same(x,main))).toHaveLength(0);
    expect(value.calls().split("\n").filter(Boolean).map(x=>JSON.parse(x)).filter(x=>x.includes("--dry=json"))).toHaveLength(2);
    expect(affectedTestReportSelection(value.worktree,bound[0]!)).toEqual(affectedTestReportSelection(value.worktree,bound[1]!));
    expect(affectedTestReportSelection(value.worktree,bound[0]!)?.tasks).toHaveLength(1);
    const advanced=value.git(["commit-tree",`${value.baseCommit}^{tree}`,"-p",value.baseCommit,"-m","Main advanced after selection"]);
    value.git(["update-ref","refs/remotes/origin/main",advanced]);
    expect(affectedTestReportSelection(value.worktree,bound[0]!)?.tasks).toHaveLength(1);
    value.git(["commit","--allow-empty","-m","Owned after-selection drift"]);
    expect(()=>affectedTestReportSelection(value.worktree,bound[0]!)).toThrow("Affected test selection owner changed");
  },30000);
  it("refuses an affected selection the wrapper did not pin to the captured main",()=>{
    const value=setup();withPath(value);installAffectedWrapper(value);
    const receipt={...syntheticReceipt(value),mainSha:value.git(["rev-parse","HEAD"])};
    expect(()=>bindCheckBudgets(value.worktree,receipt,[{argv:["pnpm","test:affected"]}])).toThrow("Affected test selection is not pinned to the captured main");
    expect(existsSync(join(value.metadata,"validation-calls.jsonl"))).toBe(false);
  },30000);
  it("accepts origin/main advancing during the selection child",()=>{
    const value=setup();withPath(value);const receipt=syntheticReceipt(value);
    install((_,args)=>{if(same(args,pair))return `${a}\n${m}`;if(same(args,head))return a;if(same(args,main))return b;return undefined;});
    expect(bindCheckBudgets(value.worktree,receipt,[{argv:["pnpm","turbo","test"]}]).map(x=>x.timeoutMs)).toEqual([66*60*1000]);
    expect(control.calls.filter(x=>same(x,pair)||same(x,head)||same(x,main))).toEqual([pair,head]);
  },30000);
  it.each(["post-head","proved-B-later-A"])("real bind refuses %s with original short circuit",kind=>{
    const value=setup();withPath(value);const receipt=syntheticReceipt(value);let first=true;
    install((_,args)=>{if(same(args,pair)){if(kind==="proved-B-later-A")throw failed(`${b}\n`);return `${a}\n${m}`;}if(same(args,head))return kind==="post-head"?b:a;if(same(args,main)){if(kind==="proved-B-later-A"&&first){first=false;return m;}return b;}return undefined;});
    expect(()=>bindCheckBudgets(value.worktree,receipt,[{argv:["pnpm","turbo","test"]}])).toThrow("Test selection refs changed during the owning budget child");
    const refs=control.calls.filter(x=>same(x,pair)||same(x,head)||same(x,main));
    expect(refs).toEqual(kind==="post-head"?[pair,head]:[pair,main,head]);
  },30000);
  it("non-test and full lint budgets add no ref reader",()=>{
    const value=setup(),receipt=syntheticReceipt(value);control.calls.length=0;
    expect(bindCheckBudgets(value.worktree,receipt,[{argv:["pnpm","test:lint"]},{argv:["pnpm","typecheck"]}]).map(x=>x.timeoutMs)).toEqual([30*60*1000,15*60*1000]);
    expect(control.calls).toEqual([]);
  },30000);
  it("keeps selected meaningful report refusal before selector child",()=>{
    const value=setup();withPath(value);const receipt=syntheticReceipt(value);
    value.write("apps/desktop/playwright-report-e2e/results.json","{}\n");
    value.write("scripts/report-reader.mjs","import {readFileSync} from 'node:fs';readFileSync('apps/desktop/playwright-report-e2e/results.json','utf8');\n");
    value.write("package.json",JSON.stringify({scripts:{turbo:"node scripts/report-reader.mjs","test:affected":"fixture"}}));value.git(["add","."]);value.git(["commit","-m","Owned selected report fixture"]);
    expect(()=>bindCheckBudgets(value.worktree,receipt,[{argv:["pnpm","turbo","test"]}])).toThrow();
    expect(existsSync(join(value.metadata,"validation-calls.jsonl"))).toBe(false);
  },30000);
  it.each(["head","main"])("real bind preserves original %s error before any selector",field=>{
    const value=setup();withPath(value);const receipt=syntheticReceipt(value),error=new Error(`original-${field}`);
    install((_,args)=>{if(same(args,pair)){if(field==="main")throw failed(`${b}\n`);return "HEAD\norigin/main";}throw error;});
    expect(()=>bindCheckBudgets(value.worktree,receipt,[{argv:["pnpm","turbo","test"]}])).toThrow(error);
    expect(control.calls).toEqual(field==="head"?[pair,head]:[pair,main]);
    expect(existsSync(join(value.metadata,"validation-calls.jsonl"))).toBe(false);
  },30000);
  it("actual canonical checkRecipe invokes paired budget owner without changed proof fields",()=>{
    const value=setup();withPath(value);const publisher=value.start("redeploy","handoff");
    try{expect(invokeSync(value,"prepare",publisher.context).status).toBe(0);}finally{publisher.finish();}
    const receipt=mainSyncReceiptSchema.parse(JSON.parse(readFileSync(join(value.metadata,"vibe-main-sync.json"),"utf8"))),source=value.sourceTurn("handoff");
    try{const context=syncContext({context:source.context},"validate");control.calls.length=0;const recipe=checkRecipe(context,receipt);
      expect(control.calls.filter(x=>same(x,pair))).toHaveLength(2);
      expect(recipe.commands.some(x=>x.argv[1]==="test:affected")).toBe(true);
      expect(recipe.commands.filter(x=>x.argv[1]==="test:affected"||(x.argv[1]==="turbo"&&x.argv[2]==="test")).map(x=>x.timeoutMs)).toEqual([66*60*1000,66*60*1000]);
      // operator ruling, 2026-10-16: the handoff recipe also binds its captured-main comparison reserve.
      expect(Object.keys(recipe).sort()).toEqual(["commands","comparison","e2eLimitations","recovery"]);
      expect(recipe.comparison).toEqual({timeoutMs:comparisonBudgetMs(recipe.commands.map(x=>({timeoutMs:x.timeoutMs!})))});
    }finally{source.finish();}
  },30000);
  void compilerNegative;
});

function setup(){const value=syncFixture();fixtures.push(value);return value;}
function same(left:string[],right:string[]){return JSON.stringify(left)===JSON.stringify(right);}
function install(reply:NonNullable<typeof control.reply>){control.calls.length=0;control.reply=reply;}
function failed(stdout:string){const stderr="fatal: synthetic missing main\n";return Object.assign(new Error(`Command failed: git rev-parse HEAD origin/main\n${stderr}`),{pid:123,status:128,signal:null,stdout,stderr,output:[null,stdout,stderr]});}
function withPath(value:ReturnType<typeof syncFixture>){const old=process.env.PATH;process.env.PATH=`${value.bin}:${old??""}`;restorers.push(()=>{if(old===undefined)Reflect.deleteProperty(process.env,"PATH");else process.env.PATH=old;});}
function syntheticReceipt(value:ReturnType<typeof syncFixture>):MainSyncReceipt{return mainSyncReceiptSchema.parse({version:1,transactionId:"10000000-0000-4000-8000-000000000001",worktree:value.worktree,branch:"vibe/test",operator:{id:"fixture-owner",email:"owner@example.invalid"},purpose:"build",mainSha:value.baseCommit,startingHead:value.baseCommit,originalBase:value.baseCommit,validationSince:value.baseCommit,fetchedAt:"2026-10-09T00:00:00Z",importedFiles:[]});}
function installAffectedWrapper(value:ReturnType<typeof syncFixture>){
  installAffectedTestWrapper(value);
  value.git(["add","."]);value.git(["commit","-m","Owned canonical wrapper fixture"]);
}
function compilerNegative(fallback:UnprovedBudgetFallback,complete:ProvedBudgetCompletion,proved:Extract<BudgetRefCapture,{kind:"proved-first-incomplete"}>,unproved:Extract<BudgetRefCapture,{kind:"unproved"}>){
  // @ts-expect-error Proved first cannot enter whole fallback.
  fallback("/owned/root",proved);
  // @ts-expect-error Knowledge is required.
  fallback("/owned/root");
  // @ts-expect-error Unproved first cannot enter main-only completion.
  complete("/owned/root",unproved);
  // @ts-expect-error Fixed reader accepts root only, not ref/operation/trust.
  readBudgetRefs("/owned/root","HEAD");
}
