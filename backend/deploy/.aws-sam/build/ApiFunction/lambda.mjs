// lambda.mjs
import { createRequire } from "module";
var require2 = createRequire(import.meta.url);
var se = (e) => {
  let t = "", r = new Uint8Array(e);
  for (let s = 0, o = r.length; s < o; s++) t += String.fromCharCode(r[s]);
  return btoa(t);
};
var oe = (e) => {
  let t = atob(e), r = new Uint8Array(new ArrayBuffer(t.length)), s = t.length / 2;
  for (let o = 0, n = t.length - 1; o <= s; o++, n--) r[o] = t.charCodeAt(o), r[n] = t.charCodeAt(n);
  return r;
};
function O(e) {
  return /[^\x00-\x7F]/.test(e) ? encodeURIComponent(e) : e;
}
var Ne = (e) => e.requestContext;
var U = (e, { isContentTypeBinary: t } = { isContentTypeBinary: void 0 }) => async (r, s) => {
  let o = We(r), n = o.createRequest(r), a = Ne(r), c = await e.fetch(n, { event: r, requestContext: a, lambdaContext: s });
  return o.createResult(r, c, { isContentTypeBinary: t });
};
var $ = class {
  getHeaderValue(e, t) {
    return e ? Array.isArray(e[t]) ? e[t][0] : e[t] : void 0;
  }
  getDomainName(e) {
    if (e.requestContext && "domainName" in e.requestContext) return e.requestContext.domainName;
    let t = this.getHeaderValue(e.headers, "host");
    if (t) return t;
    let r = "multiValueHeaders" in e ? e.multiValueHeaders : {};
    return this.getHeaderValue(r, "host");
  }
  createRequest(e) {
    let t = this.getQueryString(e), r = this.getDomainName(e), s = this.getPath(e), o = `https://${r}${s}`, n = t ? `${o}?${t}` : o, a = this.getHeaders(e), c = this.getMethod(e), i = { headers: a, method: c };
    return e.body && (i.body = e.isBase64Encoded ? oe(e.body) : e.body), new Request(n, i);
  }
  async createResult(e, t, r) {
    let s = t.headers.get("content-type"), o = r.isContentTypeBinary ?? ne, n = !!(s && o(s));
    if (!n) {
      let i = t.headers.get("content-encoding");
      n = Ge(i);
    }
    let c = { body: n ? se(await t.arrayBuffer()) : await t.text(), statusCode: t.status, isBase64Encoded: n, ..."multiValueHeaders" in e && e.multiValueHeaders ? { multiValueHeaders: {} } : { headers: {} } };
    return this.setCookies(e, t, c), c.multiValueHeaders ? t.headers.forEach((i, l) => {
      c.multiValueHeaders[l] = [i];
    }) : t.headers.forEach((i, l) => {
      c.headers[l] = i;
    }), c;
  }
  setCookies(e, t, r) {
    if (t.headers.has("set-cookie")) {
      let s = t.headers.getSetCookie ? t.headers.getSetCookie() : Array.from(t.headers.entries()).filter(([o]) => o === "set-cookie").map(([, o]) => o);
      Array.isArray(s) && (this.setCookiesToResult(r, s), t.headers.delete("set-cookie"));
    }
  }
};
var Ie = class extends $ {
  getPath(e) {
    return e.rawPath;
  }
  getMethod(e) {
    return e.requestContext.http.method;
  }
  getQueryString(e) {
    return e.rawQueryString;
  }
  getCookies(e, t) {
    Array.isArray(e.cookies) && t.set("Cookie", e.cookies.join("; "));
  }
  setCookiesToResult(e, t) {
    e.cookies = t;
  }
  getHeaders(e) {
    let t = new Headers();
    if (this.getCookies(e, t), e.headers) for (let [r, s] of Object.entries(e.headers)) s && t.set(r, s);
    return t;
  }
};
var Le = new Ie();
var De = class extends $ {
  getPath(e) {
    return e.path;
  }
  getMethod(e) {
    return e.httpMethod;
  }
  getQueryString(e) {
    return e.multiValueQueryStringParameters ? Object.entries(e.multiValueQueryStringParameters || {}).filter(([, t]) => t).map(([t, r]) => r.map((s) => `${encodeURIComponent(t)}=${encodeURIComponent(s)}`).join("&")).join("&") : Object.entries(e.queryStringParameters || {}).filter(([, t]) => t).map(([t, r]) => `${encodeURIComponent(t)}=${encodeURIComponent(r || "")}`).join("&");
  }
  getCookies(e, t) {
  }
  getHeaders(e) {
    let t = new Headers();
    if (this.getCookies(e, t), e.headers) for (let [r, s] of Object.entries(e.headers)) s && t.set(r, O(s));
    if (e.multiValueHeaders) {
      for (let [r, s] of Object.entries(e.multiValueHeaders)) if (s) {
        let o = t.get(r);
        s.forEach((n) => {
          let a = O(n);
          return (!o || !o.includes(a)) && t.append(r, a);
        });
      }
    }
    return t;
  }
  setCookiesToResult(e, t) {
    e.multiValueHeaders = { "set-cookie": t };
  }
};
var Ve = new De();
var Be = class extends $ {
  getHeaders(e) {
    let t = new Headers();
    if (e.multiValueHeaders) {
      for (let [r, s] of Object.entries(e.multiValueHeaders)) if (s && Array.isArray(s)) {
        let o = O(s.join("; "));
        t.set(r, o);
      }
    } else for (let [r, s] of Object.entries(e.headers ?? {})) s && t.set(r, O(s));
    return t;
  }
  getPath(e) {
    return e.path;
  }
  getMethod(e) {
    return e.httpMethod;
  }
  getQueryString(e) {
    return e.multiValueQueryStringParameters ? Object.entries(e.multiValueQueryStringParameters || {}).filter(([, t]) => t).map(([t, r]) => `${t}=${r.join(`&${t}=`)}`).join("&") : Object.entries(e.queryStringParameters || {}).filter(([, t]) => t).map(([t, r]) => `${t}=${r}`).join("&");
  }
  getCookies(e, t) {
    let r;
    e.multiValueHeaders ? r = e.multiValueHeaders.cookie?.join("; ") : r = e.headers ? e.headers.cookie : void 0, r && t.append("Cookie", r);
  }
  setCookiesToResult(e, t) {
    e.multiValueHeaders ? e.multiValueHeaders["set-cookie"] = t : e.headers["set-cookie"] = t.join(", ");
  }
};
var qe = new Be();
var Ue = class extends $ {
  getPath(e) {
    return e.path;
  }
  getMethod(e) {
    return e.method;
  }
  getQueryString() {
    return "";
  }
  getHeaders(e) {
    let t = new Headers();
    if (e.headers) {
      for (let [r, s] of Object.entries(e.headers)) if (s) {
        let o = t.get(r);
        s.forEach((n) => {
          let a = O(n);
          return (!o || !o.includes(a)) && t.append(r, a);
        });
      }
    }
    return t;
  }
  getCookies() {
  }
  setCookiesToResult(e, t) {
    e.headers = { ...e.headers, "set-cookie": t.join(", ") };
  }
};
var Fe = new Ue();
var We = (e) => ze(e) ? qe : Qe(e) ? Le : Ke(e) ? Fe : Ve;
var ze = (e) => e.requestContext ? Object.hasOwn(e.requestContext, "elb") : false;
var Qe = (e) => Object.hasOwn(e, "rawPath");
var Ke = (e) => e.requestContext ? Object.hasOwn(e.requestContext, "serviceArn") : false;
var ne = (e) => !/^text\/(?:plain|html|css|javascript|csv)|(?:\/|\+)(?:json|xml)\s*(?:;|$)/.test(e);
var Ge = (e) => e === null ? false : /^(gzip|deflate|compress|br)/.test(e);
var F = (e, t, r) => (s, o) => {
  let n = -1;
  return a(0);
  async function a(c) {
    if (c <= n) throw new Error("next() called multiple times");
    n = c;
    let i, l = false, h;
    if (e[c] ? (h = e[c][0][0], s.req.routeIndex = c) : h = c === e.length && o || void 0, h) try {
      i = await h(s, () => a(c + 1));
    } catch (u) {
      if (u instanceof Error && t) s.error = u, i = await t(u, s), l = true;
      else throw u;
    }
    else s.finalized === false && r && (i = await r(s));
    return i && (s.finalized === false || l) && (s.res = i), s;
  }
};
var ae = /* @__PURE__ */ Symbol();
var ie = async (e, t = /* @__PURE__ */ Object.create(null)) => {
  let { all: r = false, dot: s = false } = t, n = (e instanceof M ? e.raw.headers : e.headers).get("Content-Type");
  return n?.startsWith("multipart/form-data") || n?.startsWith("application/x-www-form-urlencoded") ? Je(e, { all: r, dot: s }) : {};
};
async function Je(e, t) {
  let r = await e.formData();
  return r ? Xe(r, t) : {};
}
function Xe(e, t) {
  let r = /* @__PURE__ */ Object.create(null);
  return e.forEach((s, o) => {
    t.all || o.endsWith("[]") ? Ye(r, o, s) : r[o] = s;
  }), t.dot && Object.entries(r).forEach(([s, o]) => {
    s.includes(".") && (Ze(r, s, o), delete r[s]);
  }), r;
}
var Ye = (e, t, r) => {
  e[t] !== void 0 ? Array.isArray(e[t]) ? e[t].push(r) : e[t] = [e[t], r] : t.endsWith("[]") ? e[t] = [r] : e[t] = r;
};
var Ze = (e, t, r) => {
  let s = e, o = t.split(".");
  o.forEach((n, a) => {
    a === o.length - 1 ? s[n] = r : ((!s[n] || typeof s[n] != "object" || Array.isArray(s[n]) || s[n] instanceof File) && (s[n] = /* @__PURE__ */ Object.create(null)), s = s[n]);
  });
};
var z = (e) => {
  let t = e.split("/");
  return t[0] === "" && t.shift(), t;
};
var ce = (e) => {
  let { groups: t, path: r } = et(e), s = z(r);
  return tt(s, t);
};
var et = (e) => {
  let t = [];
  return e = e.replace(/\{[^}]+\}/g, (r, s) => {
    let o = `@${s}`;
    return t.push([o, r]), o;
  }), { groups: t, path: e };
};
var tt = (e, t) => {
  for (let r = t.length - 1; r >= 0; r--) {
    let [s] = t[r];
    for (let o = e.length - 1; o >= 0; o--) if (e[o].includes(s)) {
      e[o] = e[o].replace(s, t[r][1]);
      break;
    }
  }
  return e;
};
var _ = {};
var le = (e, t) => {
  if (e === "*") return "*";
  let r = e.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (r) {
    let s = `${e}#${t}`;
    return _[s] || (r[2] ? _[s] = t && t[0] !== ":" && t[0] !== "*" ? [s, r[1], new RegExp(`^${r[2]}(?=/${t})`)] : [e, r[1], new RegExp(`^${r[2]}$`)] : _[s] = [e, r[1], true]), _[s];
  }
  return null;
};
var N = (e, t) => {
  try {
    return t(e);
  } catch {
    return e.replace(/(?:%[0-9A-Fa-f]{2})+/g, (r) => {
      try {
        return t(r);
      } catch {
        return r;
      }
    });
  }
};
var rt = (e) => N(e, decodeURI);
var Q = (e) => {
  let t = e.url, r = t.indexOf("/", t.indexOf(":") + 4), s = r;
  for (; s < t.length; s++) {
    let o = t.charCodeAt(s);
    if (o === 37) {
      let n = t.indexOf("?", s), a = t.slice(r, n === -1 ? void 0 : n);
      return rt(a.includes("%25") ? a.replace(/%25/g, "%2525") : a);
    } else if (o === 63) break;
  }
  return t.slice(r, s);
};
var he = (e) => {
  let t = Q(e);
  return t.length > 1 && t.at(-1) === "/" ? t.slice(0, -1) : t;
};
var b = (e, t, ...r) => (r.length && (t = b(t, ...r)), `${e?.[0] === "/" ? "" : "/"}${e}${t === "/" ? "" : `${e?.at(-1) === "/" ? "" : "/"}${t?.[0] === "/" ? t.slice(1) : t}`}`);
var I = (e) => {
  if (e.charCodeAt(e.length - 1) !== 63 || !e.includes(":")) return null;
  let t = e.split("/"), r = [], s = "";
  return t.forEach((o) => {
    if (o !== "" && !/\:/.test(o)) s += "/" + o;
    else if (/\:/.test(o)) if (/\?/.test(o)) {
      r.length === 0 && s === "" ? r.push("/") : r.push(s);
      let n = o.replace("?", "");
      s += "/" + n, r.push(s);
    } else s += "/" + o;
  }), r.filter((o, n, a) => a.indexOf(o) === n);
};
var W = (e) => /[%+]/.test(e) ? (e.indexOf("+") !== -1 && (e = e.replace(/\+/g, " ")), e.indexOf("%") !== -1 ? N(e, K) : e) : e;
var ue = (e, t, r) => {
  let s;
  if (!r && t && !/[%+]/.test(t)) {
    let a = e.indexOf("?", 8);
    if (a === -1) return;
    for (e.startsWith(t, a + 1) || (a = e.indexOf(`&${t}`, a + 1)); a !== -1; ) {
      let c = e.charCodeAt(a + t.length + 1);
      if (c === 61) {
        let i = a + t.length + 2, l = e.indexOf("&", i);
        return W(e.slice(i, l === -1 ? void 0 : l));
      } else if (c == 38 || isNaN(c)) return "";
      a = e.indexOf(`&${t}`, a + 1);
    }
    if (s = /[%+]/.test(e), !s) return;
  }
  let o = {};
  s ??= /[%+]/.test(e);
  let n = e.indexOf("?", 8);
  for (; n !== -1; ) {
    let a = e.indexOf("&", n + 1), c = e.indexOf("=", n);
    c > a && a !== -1 && (c = -1);
    let i = e.slice(n + 1, c === -1 ? a === -1 ? void 0 : a : c);
    if (s && (i = W(i)), n = a, i === "") continue;
    let l;
    c === -1 ? l = "" : (l = e.slice(c + 1, a === -1 ? void 0 : a), s && (l = W(l))), r ? (o[i] && Array.isArray(o[i]) || (o[i] = []), o[i].push(l)) : o[i] ??= l;
  }
  return t ? o[t] : o;
};
var de = ue;
var fe = (e, t) => ue(e, t, true);
var K = decodeURIComponent;
var pe = (e) => N(e, K);
var M = class {
  raw;
  #t;
  #e;
  routeIndex = 0;
  path;
  bodyCache = {};
  constructor(e, t = "/", r = [[]]) {
    this.raw = e, this.path = t, this.#e = r, this.#t = {};
  }
  param(e) {
    return e ? this.#r(e) : this.#n();
  }
  #r(e) {
    let t = this.#e[0][this.routeIndex][1][e], r = this.#o(t);
    return r && /\%/.test(r) ? pe(r) : r;
  }
  #n() {
    let e = {}, t = Object.keys(this.#e[0][this.routeIndex][1]);
    for (let r of t) {
      let s = this.#o(this.#e[0][this.routeIndex][1][r]);
      s !== void 0 && (e[r] = /\%/.test(s) ? pe(s) : s);
    }
    return e;
  }
  #o(e) {
    return this.#e[1] ? this.#e[1][e] : e;
  }
  query(e) {
    return de(this.url, e);
  }
  queries(e) {
    return fe(this.url, e);
  }
  header(e) {
    if (e) return this.raw.headers.get(e) ?? void 0;
    let t = {};
    return this.raw.headers.forEach((r, s) => {
      t[s] = r;
    }), t;
  }
  async parseBody(e) {
    return this.bodyCache.parsedBody ??= await ie(this, e);
  }
  #s = (e) => {
    let { bodyCache: t, raw: r } = this, s = t[e];
    if (s) return s;
    let o = Object.keys(t)[0];
    return o ? t[o].then((n) => (o === "json" && (n = JSON.stringify(n)), new Response(n)[e]())) : t[e] = r[e]();
  };
  json() {
    return this.#s("text").then((e) => JSON.parse(e));
  }
  text() {
    return this.#s("text");
  }
  arrayBuffer() {
    return this.#s("arrayBuffer");
  }
  blob() {
    return this.#s("blob");
  }
  formData() {
    return this.#s("formData");
  }
  addValidatedData(e, t) {
    this.#t[e] = t;
  }
  valid(e) {
    return this.#t[e];
  }
  get url() {
    return this.raw.url;
  }
  get method() {
    return this.raw.method;
  }
  get [ae]() {
    return this.#e;
  }
  get matchedRoutes() {
    return this.#e[0].map(([[, e]]) => e);
  }
  get routePath() {
    return this.#e[0].map(([[, e]]) => e)[this.routeIndex].path;
  }
};
var me = { Stringify: 1, BeforeStream: 2, Stream: 3 };
var st = (e, t) => {
  let r = new String(e);
  return r.isEscaped = true, r.callbacks = t, r;
};
var G = async (e, t, r, s, o) => {
  typeof e == "object" && !(e instanceof String) && (e instanceof Promise || (e = e.toString()), e instanceof Promise && (e = await e));
  let n = e.callbacks;
  if (!n?.length) return Promise.resolve(e);
  o ? o[0] += e : o = [e];
  let a = Promise.all(n.map((c) => c({ phase: t, buffer: o, context: s }))).then((c) => Promise.all(c.filter(Boolean).map((i) => G(i, t, false, s, o))).then(() => o[0]));
  return r ? st(await a, n) : a;
};
var ot = "text/plain; charset=UTF-8";
var J = (e, t) => ({ "Content-Type": e, ...t });
var ge = class {
  #t;
  #e;
  env = {};
  #r;
  finalized = false;
  error;
  #n;
  #o;
  #s;
  #h;
  #c;
  #l;
  #i;
  #u;
  #d;
  constructor(e, t) {
    this.#t = e, t && (this.#o = t.executionCtx, this.env = t.env, this.#l = t.notFoundHandler, this.#d = t.path, this.#u = t.matchResult);
  }
  get req() {
    return this.#e ??= new M(this.#t, this.#d, this.#u), this.#e;
  }
  get event() {
    if (this.#o && "respondWith" in this.#o) return this.#o;
    throw Error("This context has no FetchEvent");
  }
  get executionCtx() {
    if (this.#o) return this.#o;
    throw Error("This context has no ExecutionContext");
  }
  get res() {
    return this.#s ||= new Response(null, { headers: this.#i ??= new Headers() });
  }
  set res(e) {
    if (this.#s && e) {
      e = new Response(e.body, e);
      for (let [t, r] of this.#s.headers.entries()) if (t !== "content-type") if (t === "set-cookie") {
        let s = this.#s.headers.getSetCookie();
        e.headers.delete("set-cookie");
        for (let o of s) e.headers.append("set-cookie", o);
      } else e.headers.set(t, r);
    }
    this.#s = e, this.finalized = true;
  }
  render = (...e) => (this.#c ??= (t) => this.html(t), this.#c(...e));
  setLayout = (e) => this.#h = e;
  getLayout = () => this.#h;
  setRenderer = (e) => {
    this.#c = e;
  };
  header = (e, t, r) => {
    this.finalized && (this.#s = new Response(this.#s.body, this.#s));
    let s = this.#s ? this.#s.headers : this.#i ??= new Headers();
    t === void 0 ? s.delete(e) : r?.append ? s.append(e, t) : s.set(e, t);
  };
  status = (e) => {
    this.#n = e;
  };
  set = (e, t) => {
    this.#r ??= /* @__PURE__ */ new Map(), this.#r.set(e, t);
  };
  get = (e) => this.#r ? this.#r.get(e) : void 0;
  get var() {
    return this.#r ? Object.fromEntries(this.#r) : {};
  }
  #a(e, t, r) {
    let s = this.#s ? new Headers(this.#s.headers) : this.#i ?? new Headers();
    if (typeof t == "object" && "headers" in t) {
      let n = t.headers instanceof Headers ? t.headers : new Headers(t.headers);
      for (let [a, c] of n) a.toLowerCase() === "set-cookie" ? s.append(a, c) : s.set(a, c);
    }
    if (r) for (let [n, a] of Object.entries(r)) if (typeof a == "string") s.set(n, a);
    else {
      s.delete(n);
      for (let c of a) s.append(n, c);
    }
    let o = typeof t == "number" ? t : t?.status ?? this.#n;
    return new Response(e, { status: o, headers: s });
  }
  newResponse = (...e) => this.#a(...e);
  body = (e, t, r) => this.#a(e, t, r);
  text = (e, t, r) => !this.#i && !this.#n && !t && !r && !this.finalized ? new Response(e) : this.#a(e, t, J(ot, r));
  json = (e, t, r) => this.#a(JSON.stringify(e), t, J("application/json", r));
  html = (e, t, r) => {
    let s = (o) => this.#a(o, t, J("text/html; charset=UTF-8", r));
    return typeof e == "object" ? G(e, me.Stringify, false, {}).then(s) : s(e);
  };
  redirect = (e, t) => {
    let r = String(e);
    return this.header("Location", /[^\x00-\xFF]/.test(r) ? encodeURI(r) : r), this.newResponse(null, t ?? 302);
  };
  notFound = () => (this.#l ??= () => new Response(), this.#l(this));
};
var f = "ALL";
var ye = "all";
var we = ["get", "post", "put", "delete", "options", "patch"];
var L = "Can not add a route since the matcher is already built.";
var D = class extends Error {
};
var xe = "__COMPOSED_HANDLER";
var nt = (e) => e.text("404 Not Found", 404);
var Ee = (e, t) => {
  if ("getResponse" in e) {
    let r = e.getResponse();
    return t.newResponse(r.body, r);
  }
  return console.error(e), t.text("Internal Server Error", 500);
};
var Re = class be {
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  router;
  getPath;
  _basePath = "/";
  #t = "/";
  routes = [];
  constructor(t = {}) {
    [...we, ye].forEach((n) => {
      this[n] = (a, ...c) => (typeof a == "string" ? this.#t = a : this.#n(n, this.#t, a), c.forEach((i) => {
        this.#n(n, this.#t, i);
      }), this);
    }), this.on = (n, a, ...c) => {
      for (let i of [a].flat()) {
        this.#t = i;
        for (let l of [n].flat()) c.map((h) => {
          this.#n(l.toUpperCase(), this.#t, h);
        });
      }
      return this;
    }, this.use = (n, ...a) => (typeof n == "string" ? this.#t = n : (this.#t = "*", a.unshift(n)), a.forEach((c) => {
      this.#n(f, this.#t, c);
    }), this);
    let { strict: s, ...o } = t;
    Object.assign(this, o), this.getPath = s ?? true ? t.getPath ?? Q : he;
  }
  #e() {
    let t = new be({ router: this.router, getPath: this.getPath });
    return t.errorHandler = this.errorHandler, t.#r = this.#r, t.routes = this.routes, t;
  }
  #r = nt;
  errorHandler = Ee;
  route(t, r) {
    let s = this.basePath(t);
    return r.routes.map((o) => {
      let n;
      r.errorHandler === Ee ? n = o.handler : (n = async (a, c) => (await F([], r.errorHandler)(a, () => o.handler(a, c))).res, n[xe] = o.handler), s.#n(o.method, o.path, n);
    }), this;
  }
  basePath(t) {
    let r = this.#e();
    return r._basePath = b(this._basePath, t), r;
  }
  onError = (t) => (this.errorHandler = t, this);
  notFound = (t) => (this.#r = t, this);
  mount(t, r, s) {
    let o, n;
    s && (typeof s == "function" ? n = s : (n = s.optionHandler, s.replaceRequest === false ? o = (i) => i : o = s.replaceRequest));
    let a = n ? (i) => {
      let l = n(i);
      return Array.isArray(l) ? l : [l];
    } : (i) => {
      let l;
      try {
        l = i.executionCtx;
      } catch {
      }
      return [i.env, l];
    };
    o ||= (() => {
      let i = b(this._basePath, t), l = i === "/" ? 0 : i.length;
      return (h) => {
        let u = new URL(h.url);
        return u.pathname = u.pathname.slice(l) || "/", new Request(u, h);
      };
    })();
    let c = async (i, l) => {
      let h = await r(o(i.req.raw), ...a(i));
      if (h) return h;
      await l();
    };
    return this.#n(f, b(t, "*"), c), this;
  }
  #n(t, r, s) {
    t = t.toUpperCase(), r = b(this._basePath, r);
    let o = { basePath: this._basePath, path: r, method: t, handler: s };
    this.router.add(t, r, [s, o]), this.routes.push(o);
  }
  #o(t, r) {
    if (t instanceof Error) return this.errorHandler(t, r);
    throw t;
  }
  #s(t, r, s, o) {
    if (o === "HEAD") return (async () => new Response(null, await this.#s(t, r, s, "GET")))();
    let n = this.getPath(t, { env: s }), a = this.router.match(o, n), c = new ge(t, { path: n, matchResult: a, env: s, executionCtx: r, notFoundHandler: this.#r });
    if (a[0].length === 1) {
      let l;
      try {
        l = a[0][0][0][0](c, async () => {
          c.res = await this.#r(c);
        });
      } catch (h) {
        return this.#o(h, c);
      }
      return l instanceof Promise ? l.then((h) => h || (c.finalized ? c.res : this.#r(c))).catch((h) => this.#o(h, c)) : l ?? this.#r(c);
    }
    let i = F(a[0], this.errorHandler, this.#r);
    return (async () => {
      try {
        let l = await i(c);
        if (!l.finalized) throw new Error("Context is not finalized. Did you forget to return a Response object or `await next()`?");
        return l.res;
      } catch (l) {
        return this.#o(l, c);
      }
    })();
  }
  fetch = (t, ...r) => this.#s(t, r[1], r[0], t.method);
  request = (t, r, s, o) => t instanceof Request ? this.fetch(r ? new Request(t, r) : t, s, o) : (t = t.toString(), this.fetch(new Request(/^https?:\/\//.test(t) ? t : `http://localhost${b("/", t)}`, r), s, o));
  fire = () => {
    addEventListener("fetch", (t) => {
      t.respondWith(this.#s(t.request, t, void 0, t.request.method));
    });
  };
};
var V = [];
function X(e, t) {
  let r = this.buildAllMatchers(), s = (o, n) => {
    let a = r[o] || r[f], c = a[2][n];
    if (c) return c;
    let i = n.match(a[0]);
    if (!i) return [[], V];
    let l = i.indexOf("", 1);
    return [a[1][l], i];
  };
  return this.match = s, s(e, t);
}
var B = "[^/]+";
var H = ".*";
var j = "(?:|/.*)";
var P = /* @__PURE__ */ Symbol();
var at = new Set(".\\+*[^]$()");
function it(e, t) {
  return e.length === 1 ? t.length === 1 ? e < t ? -1 : 1 : -1 : t.length === 1 || e === H || e === j ? 1 : t === H || t === j ? -1 : e === B ? 1 : t === B ? -1 : e.length === t.length ? e < t ? -1 : 1 : t.length - e.length;
}
var Pe = class Y {
  #t;
  #e;
  #r = /* @__PURE__ */ Object.create(null);
  insert(t, r, s, o, n) {
    if (t.length === 0) {
      if (this.#t !== void 0) throw P;
      if (n) return;
      this.#t = r;
      return;
    }
    let [a, ...c] = t, i = a === "*" ? c.length === 0 ? ["", "", H] : ["", "", B] : a === "/*" ? ["", "", j] : a.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/), l;
    if (i) {
      let h = i[1], u = i[2] || B;
      if (h && i[2] && (u === ".*" || (u = u.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:"), /\((?!\?:)/.test(u)))) throw P;
      if (l = this.#r[u], !l) {
        if (Object.keys(this.#r).some((d) => d !== H && d !== j)) throw P;
        if (n) return;
        l = this.#r[u] = new Y(), h !== "" && (l.#e = o.varIndex++);
      }
      !n && h !== "" && s.push([h, l.#e]);
    } else if (l = this.#r[a], !l) {
      if (Object.keys(this.#r).some((h) => h.length > 1 && h !== H && h !== j)) throw P;
      if (n) return;
      l = this.#r[a] = new Y();
    }
    l.insert(c, r, s, o, n);
  }
  buildRegExpStr() {
    let r = Object.keys(this.#r).sort(it).map((s) => {
      let o = this.#r[s];
      return (typeof o.#e == "number" ? `(${s})@${o.#e}` : at.has(s) ? `\\${s}` : s) + o.buildRegExpStr();
    });
    return typeof this.#t == "number" && r.unshift(`#${this.#t}`), r.length === 0 ? "" : r.length === 1 ? r[0] : "(?:" + r.join("|") + ")";
  }
};
var Ce = class {
  #t = { varIndex: 0 };
  #e = new Pe();
  insert(e, t, r) {
    let s = [], o = [];
    for (let a = 0; ; ) {
      let c = false;
      if (e = e.replace(/\{[^}]+\}/g, (i) => {
        let l = `@\\${a}`;
        return o[a] = [l, i], a++, c = true, l;
      }), !c) break;
    }
    let n = e.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let a = o.length - 1; a >= 0; a--) {
      let [c] = o[a];
      for (let i = n.length - 1; i >= 0; i--) if (n[i].indexOf(c) !== -1) {
        n[i] = n[i].replace(c, o[a][1]);
        break;
      }
    }
    return this.#e.insert(n, t, s, this.#t, r), s;
  }
  buildRegExp() {
    let e = this.#e.buildRegExpStr();
    if (e === "") return [/^$/, [], []];
    let t = 0, r = [], s = [];
    return e = e.replace(/#(\d+)|@(\d+)|\.\*\$/g, (o, n, a) => n !== void 0 ? (r[++t] = Number(n), "$()") : (a !== void 0 && (s[Number(a)] = ++t), "")), [new RegExp(`^${e}`), r, s];
  }
};
var ct = [/^$/, [], /* @__PURE__ */ Object.create(null)];
var Ae = /* @__PURE__ */ Object.create(null);
function ve(e) {
  return Ae[e] ??= new RegExp(e === "*" ? "" : `^${e.replace(/\/\*$|([.\\+*[^\]$()])/g, (t, r) => r ? `\\${r}` : "(?:|/.*)")}$`);
}
function lt() {
  Ae = /* @__PURE__ */ Object.create(null);
}
function ht(e) {
  let t = new Ce(), r = [];
  if (e.length === 0) return ct;
  let s = e.map((l) => [!/\*|\/:/.test(l[0]), ...l]).sort(([l, h], [u, d]) => l ? 1 : u ? -1 : h.length - d.length), o = /* @__PURE__ */ Object.create(null);
  for (let l = 0, h = -1, u = s.length; l < u; l++) {
    let [d, m, y] = s[l];
    d ? o[m] = [y.map(([g]) => [g, /* @__PURE__ */ Object.create(null)]), V] : h++;
    let p;
    try {
      p = t.insert(m, h, d);
    } catch (g) {
      throw g === P ? new D(m) : g;
    }
    d || (r[h] = y.map(([g, E]) => {
      let k = /* @__PURE__ */ Object.create(null);
      for (E -= 1; E >= 0; E--) {
        let [T, w] = p[E];
        k[T] = w;
      }
      return [g, k];
    }));
  }
  let [n, a, c] = t.buildRegExp();
  for (let l = 0, h = r.length; l < h; l++) for (let u = 0, d = r[l].length; u < d; u++) {
    let m = r[l][u]?.[1];
    if (!m) continue;
    let y = Object.keys(m);
    for (let p = 0, g = y.length; p < g; p++) m[y[p]] = c[m[y[p]]];
  }
  let i = [];
  for (let l in a) i[l] = r[a[l]];
  return [n, i, o];
}
function C(e, t) {
  if (e) {
    for (let r of Object.keys(e).sort((s, o) => o.length - s.length)) if (ve(r).test(t)) return [...e[r]];
  }
}
var q = class {
  name = "RegExpRouter";
  #t;
  #e;
  constructor() {
    this.#t = { [f]: /* @__PURE__ */ Object.create(null) }, this.#e = { [f]: /* @__PURE__ */ Object.create(null) };
  }
  add(e, t, r) {
    let s = this.#t, o = this.#e;
    if (!s || !o) throw new Error(L);
    s[e] || [s, o].forEach((c) => {
      c[e] = /* @__PURE__ */ Object.create(null), Object.keys(c[f]).forEach((i) => {
        c[e][i] = [...c[f][i]];
      });
    }), t === "/*" && (t = "*");
    let n = (t.match(/\/:/g) || []).length;
    if (/\*$/.test(t)) {
      let c = ve(t);
      e === f ? Object.keys(s).forEach((i) => {
        s[i][t] ||= C(s[i], t) || C(s[f], t) || [];
      }) : s[e][t] ||= C(s[e], t) || C(s[f], t) || [], Object.keys(s).forEach((i) => {
        (e === f || e === i) && Object.keys(s[i]).forEach((l) => {
          c.test(l) && s[i][l].push([r, n]);
        });
      }), Object.keys(o).forEach((i) => {
        (e === f || e === i) && Object.keys(o[i]).forEach((l) => c.test(l) && o[i][l].push([r, n]));
      });
      return;
    }
    let a = I(t) || [t];
    for (let c = 0, i = a.length; c < i; c++) {
      let l = a[c];
      Object.keys(o).forEach((h) => {
        (e === f || e === h) && (o[h][l] ||= [...C(s[h], l) || C(s[f], l) || []], o[h][l].push([r, n - i + c + 1]));
      });
    }
  }
  match = X;
  buildAllMatchers() {
    let e = /* @__PURE__ */ Object.create(null);
    return Object.keys(this.#e).concat(Object.keys(this.#t)).forEach((t) => {
      e[t] ||= this.#r(t);
    }), this.#t = this.#e = void 0, lt(), e;
  }
  #r(e) {
    let t = [], r = e === f;
    return [this.#t, this.#e].forEach((s) => {
      let o = s[e] ? Object.keys(s[e]).map((n) => [n, s[e][n]]) : [];
      o.length !== 0 ? (r ||= true, t.push(...o)) : e !== f && t.push(...Object.keys(s[f]).map((n) => [n, s[f][n]]));
    }), r ? ht(t) : null;
  }
};
var Z = class {
  name = "SmartRouter";
  #t = [];
  #e = [];
  constructor(e) {
    this.#t = e.routers;
  }
  add(e, t, r) {
    if (!this.#e) throw new Error(L);
    this.#e.push([e, t, r]);
  }
  match(e, t) {
    if (!this.#e) throw new Error("Fatal error");
    let r = this.#t, s = this.#e, o = r.length, n = 0, a;
    for (; n < o; n++) {
      let c = r[n];
      try {
        for (let i = 0, l = s.length; i < l; i++) c.add(...s[i]);
        a = c.match(e, t);
      } catch (i) {
        if (i instanceof D) continue;
        throw i;
      }
      this.match = c.match.bind(c), this.#t = [c], this.#e = void 0;
      break;
    }
    if (n === o) throw new Error("Fatal error");
    return this.name = `SmartRouter + ${this.activeRouter.name}`, a;
  }
  get activeRouter() {
    if (this.#e || this.#t.length !== 1) throw new Error("No active router has been determined yet.");
    return this.#t[0];
  }
};
var S = /* @__PURE__ */ Object.create(null);
var Oe = class He {
  #t;
  #e;
  #r;
  #n = 0;
  #o = S;
  constructor(t, r, s) {
    if (this.#e = s || /* @__PURE__ */ Object.create(null), this.#t = [], t && r) {
      let o = /* @__PURE__ */ Object.create(null);
      o[t] = { handler: r, possibleKeys: [], score: 0 }, this.#t = [o];
    }
    this.#r = [];
  }
  insert(t, r, s) {
    this.#n = ++this.#n;
    let o = this, n = ce(r), a = [];
    for (let c = 0, i = n.length; c < i; c++) {
      let l = n[c], h = n[c + 1], u = le(l, h), d = Array.isArray(u) ? u[0] : l;
      if (d in o.#e) {
        o = o.#e[d], u && a.push(u[1]);
        continue;
      }
      o.#e[d] = new He(), u && (o.#r.push(u), a.push(u[1])), o = o.#e[d];
    }
    return o.#t.push({ [t]: { handler: s, possibleKeys: a.filter((c, i, l) => l.indexOf(c) === i), score: this.#n } }), o;
  }
  #s(t, r, s, o) {
    let n = [];
    for (let a = 0, c = t.#t.length; a < c; a++) {
      let i = t.#t[a], l = i[r] || i[f], h = {};
      if (l !== void 0 && (l.params = /* @__PURE__ */ Object.create(null), n.push(l), s !== S || o && o !== S)) for (let u = 0, d = l.possibleKeys.length; u < d; u++) {
        let m = l.possibleKeys[u], y = h[l.score];
        l.params[m] = o?.[m] && !y ? o[m] : s[m] ?? o?.[m], h[l.score] = true;
      }
    }
    return n;
  }
  search(t, r) {
    let s = [];
    this.#o = S;
    let n = [this], a = z(r), c = [];
    for (let i = 0, l = a.length; i < l; i++) {
      let h = a[i], u = i === l - 1, d = [];
      for (let m = 0, y = n.length; m < y; m++) {
        let p = n[m], g = p.#e[h];
        g && (g.#o = p.#o, u ? (g.#e["*"] && s.push(...this.#s(g.#e["*"], t, p.#o)), s.push(...this.#s(g, t, p.#o))) : d.push(g));
        for (let E = 0, k = p.#r.length; E < k; E++) {
          let T = p.#r[E], w = p.#o === S ? {} : { ...p.#o };
          if (T === "*") {
            let R = p.#e["*"];
            R && (s.push(...this.#s(R, t, p.#o)), R.#o = w, d.push(R));
            continue;
          }
          let [$e, re, v] = T;
          if (!h && !(v instanceof RegExp)) continue;
          let x = p.#e[$e], Me = a.slice(i).join("/");
          if (v instanceof RegExp) {
            let R = v.exec(Me);
            if (R) {
              if (w[re] = R[0], s.push(...this.#s(x, t, p.#o, w)), Object.keys(x.#e).length) {
                x.#o = w;
                let _e = R[0].match(/\//)?.length ?? 0;
                (c[_e] ||= []).push(x);
              }
              continue;
            }
          }
          (v === true || v.test(h)) && (w[re] = h, u ? (s.push(...this.#s(x, t, w, p.#o)), x.#e["*"] && s.push(...this.#s(x.#e["*"], t, w, p.#o))) : (x.#o = w, d.push(x)));
        }
      }
      n = d.concat(c.shift() ?? []);
    }
    return s.length > 1 && s.sort((i, l) => i.score - l.score), [s.map(({ handler: i, params: l }) => [i, l])];
  }
};
var ee = class {
  name = "TrieRouter";
  #t;
  constructor() {
    this.#t = new Oe();
  }
  add(e, t, r) {
    let s = I(t);
    if (s) {
      for (let o = 0, n = s.length; o < n; o++) this.#t.insert(e, s[o], r);
      return;
    }
    this.#t.insert(e, t, r);
  }
  match(e, t) {
    return this.#t.search(e, t);
  }
};
var te = class extends Re {
  constructor(e = {}) {
    super(e), this.router = e.router ?? new Z({ routers: [new q(), new ee()] });
  }
};
function ut() {
  let { process: e, Deno: t } = globalThis;
  return !(typeof t?.noColor == "boolean" ? t.noColor : e !== void 0 ? "NO_COLOR" in e?.env : false);
}
async function je() {
  let { navigator: e } = globalThis, t = "cloudflare:workers";
  return !(e !== void 0 && e.userAgent === "Cloudflare-Workers" ? await (async () => {
    try {
      return "NO_COLOR" in ((await import(t)).env ?? {});
    } catch {
      return false;
    }
  })() : !ut());
}
var dt = (e) => {
  let [t, r] = [",", "."];
  return e.map((o) => o.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, "$1" + t)).join(r);
};
var ft = (e) => {
  let t = Date.now() - e;
  return dt([t < 1e3 ? t + "ms" : Math.round(t / 1e3) + "s"]);
};
var pt = async (e) => {
  if (await je()) switch (e / 100 | 0) {
    case 5:
      return `\x1B[31m${e}\x1B[0m`;
    case 4:
      return `\x1B[33m${e}\x1B[0m`;
    case 3:
      return `\x1B[36m${e}\x1B[0m`;
    case 2:
      return `\x1B[32m${e}\x1B[0m`;
  }
  return `${e}`;
};
async function Se(e, t, r, s, o = 0, n) {
  let a = t === "<--" ? `${t} ${r} ${s}` : `${t} ${r} ${s} ${await pt(o)} ${n}`;
  e(a);
}
var ke = (e = console.log) => async function(r, s) {
  let { method: o, url: n } = r.req, a = n.slice(n.indexOf("/", 8));
  await Se(e, "<--", o, a);
  let c = Date.now();
  await s(), await Se(e, "-->", o, a, r.res.status, ft(c));
};
var Te = (e) => {
  let r = { ...{ origin: "*", allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"], allowHeaders: [], exposeHeaders: [] }, ...e }, s = /* @__PURE__ */ ((n) => typeof n == "string" ? n === "*" ? () => n : (a) => n === a ? a : null : typeof n == "function" ? n : (a) => n.includes(a) ? a : null)(r.origin), o = ((n) => typeof n == "function" ? n : Array.isArray(n) ? () => n : () => [])(r.allowMethods);
  return async function(a, c) {
    function i(h, u) {
      a.res.headers.set(h, u);
    }
    let l = await s(a.req.header("origin") || "", a);
    if (l && i("Access-Control-Allow-Origin", l), r.credentials && i("Access-Control-Allow-Credentials", "true"), r.exposeHeaders?.length && i("Access-Control-Expose-Headers", r.exposeHeaders.join(",")), a.req.method === "OPTIONS") {
      r.origin !== "*" && i("Vary", "Origin"), r.maxAge != null && i("Access-Control-Max-Age", r.maxAge.toString());
      let h = await o(a.req.header("origin") || "", a);
      h.length && i("Access-Control-Allow-Methods", h.join(","));
      let u = r.allowHeaders;
      if (!u?.length) {
        let d = a.req.header("Access-Control-Request-Headers");
        d && (u = d.split(/\s*,\s*/));
      }
      return u?.length && (i("Access-Control-Allow-Headers", u.join(",")), a.res.headers.append("Vary", "Access-Control-Request-Headers")), a.res.headers.delete("Content-Length"), a.res.headers.delete("Content-Type"), new Response(null, { headers: a.res.headers, status: 204, statusText: "No Content" });
    }
    await c(), r.origin !== "*" && a.header("Vary", "Origin", { append: true });
  };
};
var A = new te();
A.use("*", ke());
A.use("*", Te());
A.get("/health", (e) => e.json({ status: "ok", version: "0.0.1", timestamp: (/* @__PURE__ */ new Date()).toISOString() }));
A.get("/", (e) => e.json({ name: "Cast Backend", version: "0.0.1", docs: "/health" }));
var mt = U(A);
var rs = async (e, t) => {
  let r = e.requestContext?.stage;
  return r && e.rawPath?.startsWith(`/${r}`) && (e.rawPath = e.rawPath.slice(r.length + 1) || "/"), mt(e, t);
};
export {
  rs as handler
};
//# sourceMappingURL=lambda.mjs.map
