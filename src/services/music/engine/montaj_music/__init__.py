"""Montaj Studio's music nodes for ComfyUI. The app starts ComfyUI with only this package enabled and runs one node per
job: the request is JSON; progress goes to the app as "montaj-music.progress" events (the sampler's own step events
come from ComfyUI); a cancel is ComfyUI's interrupt."""
import json
import traceback


def _notify(job, client):
    from server import PromptServer

    def notify(stage, message):
        PromptServer.instance.send_sync("montaj-music.progress", {"job": job, "stage": stage, "message": message}, client)
    return notify


def _check():
    import comfy.model_management as mm
    mm.throw_exception_if_processing_interrupted()


class MontajMusicCompose:
    """New music from a description (ACE-Step 1.5 Turbo); optionally inspired by a reference's sound."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"request": ("STRING", {"multiline": True})}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "Montaj"

    @classmethod
    def IS_CHANGED(cls, request):
        return float("nan")  # every job runs

    def run(self, request):
        from .compose import compose
        req = json.loads(request)
        notify = _notify(req.get("job"), req.get("client") or None)
        try:
            report = compose(req, notify, _check)
        except Exception as e:  # noqa: BLE001 — the app shows the message; the traceback goes to the engine log
            if type(e).__name__ != "InterruptProcessingException":
                traceback.print_exc()
            raise
        notify("done", "اكتمل")
        return {"ui": {"montaj": [json.dumps({"job": req.get("job"), "report": report["files"]["wav"]}, ensure_ascii=False)]}}


def _routes():
    """The engine's own process (the venv's python.exe is only a launcher): the app measures this pid's memory."""
    import os
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/montaj-music/process")
    async def process(_request):
        return web.json_response({"pid": os.getpid()})


try:
    _routes()
except Exception:  # noqa: BLE001 — imported outside a running server (tests): no route
    pass

NODE_CLASS_MAPPINGS = {"MontajMusicCompose": MontajMusicCompose}
NODE_DISPLAY_NAME_MAPPINGS = {"MontajMusicCompose": "Montaj · تأليف موسيقى جديدة"}
