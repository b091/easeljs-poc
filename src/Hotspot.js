export class Hotspot {

    container;

    constructor(picture) {

        this.container = new createjs.Container();
        this.createBitmap(picture);

        return this.container;
    }

    createBitmap(picture) {
        let bitmap = new createjs.Bitmap(picture);
        this.container.addChild(bitmap);
        let shape = this.createShape(bitmap);

        bitmap.on("rollover", function() {
            shape.visible = true;
            stage.update();
        });
        bitmap.on("rollout", function() {
            shape.visible = false;
            stage.update();
        });

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

