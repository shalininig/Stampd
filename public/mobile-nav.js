/* Stampd — phone-friendly top menu.
 * On narrow screens the links fold into a ☰ button; tapping it drops the menu
 * down. Works on any page whose <nav> holds the logo and one <div> of links.
 * Wide screens are untouched. */
(function () {
  var nav = document.querySelector("nav");
  if (!nav) return;
  var links = nav.querySelector(":scope > div");
  if (!links) return;
  links.classList.add("snav-links");
  if (!links.id) links.id = "snav-links";

  var css =
    ".snav-btn{display:none;width:44px;height:44px;border:1px solid rgba(255,255,255,.18);border-radius:12px;" +
    "background:rgba(255,255,255,.04);cursor:pointer;align-items:center;justify-content:center;flex-direction:column;gap:5px;padding:0}" +
    ".snav-btn span{display:block;width:20px;height:2px;border-radius:2px;background:#fff;transition:transform .2s,opacity .2s}" +
    "nav.snav-open .snav-btn span:nth-child(1){transform:translateY(7px) rotate(45deg)}" +
    "nav.snav-open .snav-btn span:nth-child(2){opacity:0}" +
    "nav.snav-open .snav-btn span:nth-child(3){transform:translateY(-7px) rotate(-45deg)}" +
    "@media (max-width:760px){" +
    "nav{padding-top:12px!important;padding-bottom:12px!important}" +
    ".snav-btn{display:flex}" +
    "nav .snav-links{display:none!important;position:absolute;top:100%;left:0;right:0;flex-direction:column;align-items:stretch!important;" +
    "gap:0!important;background:#0D0500;border-bottom:1px solid rgba(255,48,8,.25);padding:6px 20px 20px;box-shadow:0 18px 30px rgba(0,0,0,.5)}" +
    "nav.snav-open .snav-links{display:flex!important}" +
    "nav .snav-links a{padding:15px 2px!important;font-size:1rem!important;border-bottom:1px solid rgba(255,255,255,.07)}" +
    "nav .snav-links a.nav-cta{margin-top:14px;text-align:center;border-bottom:none;padding:14px!important;border-radius:50px}" +
    "}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "snav-btn";
  btn.setAttribute("aria-label", "Menu");
  btn.setAttribute("aria-controls", links.id);
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = "<span></span><span></span><span></span>";
  nav.appendChild(btn);

  function setOpen(open) {
    nav.classList.toggle("snav-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    setOpen(!nav.classList.contains("snav-open"));
  });
  links.addEventListener("click", function (e) {
    if (e.target.closest("a")) setOpen(false);
  });
  document.addEventListener("click", function (e) {
    if (!nav.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setOpen(false);
  });
})();
