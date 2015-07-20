import * as Hammer from 'hammer';

export class Hotspot {

    container;

    constructor(picture) {
        this.container = new createjs.Container();
        let bitmap = this.createBitmap(picture);
        let shape = this.createShape(bitmap);

        this.container.on("mousedown", () => {
            bitmap.shadow = new createjs.Shadow("#000000", 5, 5, 10);
            this.container.parent.updateCache();
        });

        this.container.on("pressup", () => {
            bitmap.shadow = null;
            this.container.parent.updateCache();
        });

        return this.container;
    }

    createBitmap(picture) {
        let bitmap = new createjs.Bitmap(picture);
        this.container.addChild(bitmap);
        return bitmap;
    }

    createShape(bitmap) {
        let shape = new createjs.Shape();
        let bitmapBounds = bitmap.getBounds();

        shape.graphics.setStrokeStyle(10)
            .beginStroke("red")
            .drawRect(0, 0, bitmapBounds.height, bitmapBounds.width);

        shape.visible = false;

        this.container.addChild(shape);

        return shape;
    }

    static setRandomPosition(container) {
        var containerBounds = container.getBounds();
        var parentContainerBounds = container.parent.getBounds();
        container.x = Math.floor(Math.random() * (parentContainerBounds.width - containerBounds.width)) + 1;
        container.y = Math.floor(Math.random() * (parentContainerBounds.height - containerBounds.height)) + 1;
    }

}

