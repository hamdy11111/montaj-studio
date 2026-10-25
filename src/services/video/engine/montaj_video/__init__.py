"""Montaj Studio's video nodes for ComfyUI. The generation and enhancement graphs use ComfyUI's own nodes (MiniMax H3,
SAM 3.1, SeedVR2); this package only adds what the app needs around them: a pass-through that frees the models
between sampling and decoding (so the video VAE has the GPU's memory) and the route that tells the app the engine's
real process id."""


class _Any(str):
    """A type every input and output accepts."""

    def __ne__(self, other):
        return False


ANY = _Any("*")


class MontajFreeModels:
    """Passes its input on after unloading every model from the GPU."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": (ANY,)}}

    RETURN_TYPES = (ANY,)
    FUNCTION = "run"
    CATEGORY = "Montaj"

    def run(self, value):
        import comfy.model_management as mm
        mm.unload_all_models()
        mm.soft_empty_cache()
        return (value,)


def _routes():
    """The engine's own process (the venv's python.exe is only a launcher): the app measures this pid's memory."""
    import os
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/montaj/process")
    async def process(_request):
        return web.json_response({"pid": os.getpid()})


try:
    _routes()
except Exception:  # noqa: BLE001 — imported outside a running server (tests): no route
    pass

NODE_CLASS_MAPPINGS = {"MontajFreeModels": MontajFreeModels}
NODE_DISPLAY_NAME_MAPPINGS = {"MontajFreeModels": "Montaj · تفريغ النماذج"}
