"""
Adapter registry: register and look up HarnessAdapter subclasses by name.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from harness.adapter import HarnessAdapter

# Module-level registry: maps adapter name -> adapter class.
_REGISTRY: dict[str, type["HarnessAdapter"]] = {}


def register(adapter_cls: type["HarnessAdapter"]) -> type["HarnessAdapter"]:
    """Register an adapter class under its ``name`` attribute.

    Can be used as a class decorator::

        @register
        class MyAdapter(HarnessAdapter):
            name = "my-adapter"
            ...

    Parameters
    ----------
    adapter_cls:
        A concrete subclass of ``HarnessAdapter`` with a ``name`` class variable.

    Returns
    -------
    adapter_cls
        The same class, so the decorator form works transparently.
    """
    _REGISTRY[adapter_cls.name] = adapter_cls
    return adapter_cls


def get_adapter(name: str) -> type["HarnessAdapter"]:
    """Return the registered adapter class for ``name``.

    Parameters
    ----------
    name:
        The adapter's ``name`` attribute value.

    Raises
    ------
    KeyError
        If no adapter with the given name has been registered. The error
        message names all currently registered keys so the caller knows
        what is available.
    """
    if name not in _REGISTRY:
        available = ", ".join(sorted(_REGISTRY)) or "(none)"
        raise KeyError(
            f"No adapter registered with name {name!r}. "
            f"Available adapters: {available}"
        )
    return _REGISTRY[name]
